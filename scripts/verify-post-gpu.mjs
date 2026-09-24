/**
 * npm run dev 后执行 node scripts/verify-post-gpu.mjs。
 * 独立 Chrome headless / WebGL2，不加载 App，不连接现有浏览器。
 * 回归对象：非一致 CoC 分支中的隐式 LOD 把天空粗 mip 泄漏到黑色海面。
 * 当前散景为 gather-as-scatter：a 通道是以渲染像素计的弥散圈半径，圆盘采样逐像素随机旋转，
 * 因此采样坐标的屏幕导数很大，隐式 LOD 会落到粗 mip；实际 shader 的每个采样点都显式给出 LOD。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaderPath = resolve(projectRoot, 'src/ocean/post.frag.glsl');
const outputPath = resolve(projectRoot, '分析/reference-20260921/optimization-v9/post-gpu-verification.json');
const shader = await readFile(shaderPath, 'utf8');
const legacyShader = shader.replace(/textureLod\(\s*uScene\s*,\s*vUv\s*\+\s*offset\s*\*\s*pixel\s*,\s*lod\s*\)/,
  'texture2D(uScene, vUv + offset * pixel)');
if (legacyShader === shader) throw new Error('The actual post shader must read every bokeh tap with an explicit LOD.');
const baseURL = process.env.OCEAN_BASE_URL ?? 'http://127.0.0.1:4188';
const verificationURL = new URL('/__post_gpu_verification__', baseURL).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.route(verificationURL, (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(verificationURL);
  const result = await page.evaluate(async ({ shader, legacyShader }) => {
    const T = await import('/node_modules/three/build/three.module.js');
    const width = 1024, height = 512, tolerance = 0.004;
    const renderer = new T.WebGLRenderer({ antialias: false });
    renderer.setSize(width, height);
    renderer.toneMapping = T.NoToneMapping;
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const environment = {
      userAgent: navigator.userAgent, webglVersion: gl.getParameter(gl.VERSION),
      gpuRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    };
    const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
    const hdr = new T.WebGLRenderTarget(width, height, {
      type: T.HalfFloatType, format: T.RGBAFormat,
      minFilter: T.LinearMipmapLinearFilter, magFilter: T.LinearFilter,
      generateMipmaps: true, depthBuffer: false, stencilBuffer: false, colorSpace: T.NoColorSpace,
    });
    const output = new T.WebGLRenderTarget(width, height, {
      type: T.FloatType, format: T.RGBAFormat,
      minFilter: T.NearestFilter, magFilter: T.NearestFilter,
      depthBuffer: false, stencilBuffer: false, colorSpace: T.NoColorSpace,
    });
    const makeMaterial = (fragmentShader, uniforms = {}) => new T.ShaderMaterial({
      vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const input = makeMaterial(`
      precision highp float;
      varying vec2 vUv;
      uniform int uCase;
      void main(){
        // 黑海与亮天空隔开；测试区距天空超过100px，远大于合法散景半径（≤26px）与其采样 mip 足迹。
        // a 为弥散圈半径（渲染像素）：0.75px 以下不做散景。
        float alpha=.75+9.*(vUv.x-.5)
          +3.*sin(vUv.y*47.+vUv.x*13.)+1.5*sin(vUv.x*83.-vUv.y*19.);
        alpha=clamp(alpha,0.,20.);
        if(uCase==1)alpha=.3;
        if(uCase==2||uCase==3)alpha=12.;
        bool sky=vUv.y>.70;
        vec3 sea=vec3(0.);
        // 散景生效对照：海面中央一个 3×3 的亮点，应被摊成半径约 12px 的圆盘。
        if(uCase==3&&max(abs(gl_FragCoord.x-512.),abs(gl_FragCoord.y-128.))<1.5)sea=vec3(40.);
        gl_FragColor=vec4(sky?vec3(14.,12.,8.):sea,sky?0.:alpha);
      }
    `, { uCase: { value: 0 } });
    // 眩光金字塔置黑：只检验散景本身，bloom 另有自己的 mip 输入。
    const blackBright = new T.DataTexture(new Uint8Array(4), 1, 1);
    blackBright.needsUpdate = true;
    const uniforms = {
      uScene: { value: hdr.texture }, uBright: { value: blackBright },
      uTexel: { value: new T.Vector2(1 / width, 1 / height) },
      uTime: { value: 12 }, uProgress: { value: 0 }, uFocus: { value: new T.Vector3(15, 16, 26) },
    };
    const fixed = makeMaterial(shader, uniforms);
    const legacy = makeMaterial(legacyShader, uniforms);
    const copy = makeMaterial('varying vec2 vUv;uniform sampler2D uScene;void main(){gl_FragColor=textureLod(uScene,vUv,0.);}', uniforms);
    const scene = new T.Scene();
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new T.PlaneGeometry(2, 2);
    const mesh = new T.Mesh(geometry, input);
    scene.add(mesh);
    const pixels = new Float32Array(width * height * 4);
    const roi = { xMin: 32, xMaxExclusive: width - 32, yMin: 32, yMaxExclusive: height / 2 };
    const roiPixelCount = (roi.xMaxExclusive - roi.xMin) * (roi.yMaxExclusive - roi.yMin);

    function drawAndRead(material) {
      mesh.material = material;
      renderer.setRenderTarget(output);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(output, 0, 0, width, height, pixels);
    }
    function regionStats() {
      let maxAbsoluteColor = 0, maxPositiveColor = 0, aboveTolerancePixelCount = 0;
      let nonFiniteValueCount = 0, positiveSquaredSum = 0;
      let worstPixel = null;
      for (let y = roi.yMin; y < roi.yMaxExclusive; y += 1) {
        for (let x = roi.xMin; x < roi.xMaxExclusive; x += 1) {
          const index = (y * width + x) * 4;
          let pixelAboveTolerance = false;
          for (let channel = 0; channel < 3; channel += 1) {
            const value = pixels[index + channel];
            if (!Number.isFinite(value)) nonFiniteValueCount += 1;
            maxAbsoluteColor = Math.max(maxAbsoluteColor, Math.abs(value));
            if (value > maxPositiveColor) { maxPositiveColor = value; worstPixel = [x, y]; }
            if (value > tolerance) pixelAboveTolerance = true;
            positiveSquaredSum += Math.max(0, value) ** 2;
          }
          if (pixelAboveTolerance) aboveTolerancePixelCount += 1;
        }
      }
      return {
        maxAbsoluteColor, maxPositiveColor, aboveTolerancePixelCount, nonFiniteValueCount,
        rmsPositiveColor: Math.sqrt(positiveSquaredSum / (roiPixelCount * 3)), worstPixel,
        blackWithinTolerance: nonFiniteValueCount === 0 && maxAbsoluteColor <= tolerance,
      };
    }
    // 亮点扩散范围：确认散景分支真的执行，而不是因为没有采样才保持全黑。
    function spotSpread() {
      let litPixelCount = 0, maxDistance = 0;
      for (let y = roi.yMin; y < roi.yMaxExclusive; y += 1) {
        for (let x = roi.xMin; x < roi.xMaxExclusive; x += 1) {
          const index = (y * width + x) * 4;
          if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > tolerance) {
            litPixelCount += 1;
            maxDistance = Math.max(maxDistance, Math.hypot(x - 512, y - 128));
          }
        }
      }
      return { litPixelCount, maxDistance };
    }
    function cocCoverage() {
      let below = 0, above = 0, mixedHorizontalNeighborPairs = 0;
      for (let y = roi.yMin; y < roi.yMaxExclusive; y += 1) {
        for (let x = roi.xMin; x < roi.xMaxExclusive; x += 1) {
          const index = (y * width + x) * 4;
          const active = pixels[index + 3] > .75;
          if (active) above += 1; else below += 1;
          if (x + 1 < roi.xMaxExclusive && active !== (pixels[index + 7] > .75)) {
            mixedHorizontalNeighborPairs += 1;
          }
        }
      }
      return { belowThresholdPixelCount: below, aboveThresholdPixelCount: above, mixedHorizontalNeighborPairs };
    }

    const cases = [];
    let engagement = null;
    try {
      for (const [index, name] of ['curved-coc-threshold', 'uniform-dof-disabled', 'uniform-dof-enabled'].entries()) {
        input.uniforms.uCase.value = index;
        mesh.material = input;
        renderer.setRenderTarget(hdr);
        renderer.render(scene, camera); // 实际构建完整 mip 链。
        drawAndRead(copy);
        const inputStats = regionStats();
        const coverage = cocCoverage();
        drawAndRead(legacy);
        const legacyStats = regionStats();
        drawAndRead(fixed);
        const fixedStats = regionStats();
        cases.push({ name, inputStats, coverage, legacyImplicitLod: legacyStats, currentExplicitLod: fixedStats });
      }
      input.uniforms.uCase.value = 3;
      mesh.material = input;
      renderer.setRenderTarget(hdr);
      renderer.render(scene, camera);
      drawAndRead(fixed);
      engagement = { name: 'bokeh-engagement', spotCenter: [512, 128], spotRadiusPx: 12, ...spotSpread() };
    } finally {
      renderer.setRenderTarget(null);
      [input, fixed, legacy, copy, geometry, hdr, output, blackBright].forEach((resource) => resource.dispose());
      renderer.dispose();
    }
    const boundary = cases[0];
    const assertions = {
      sourceSeaIsBlack: cases.every((entry) => entry.inputStats.maxAbsoluteColor === 0),
      thresholdCrossingExists: boundary.coverage.aboveThresholdPixelCount > 0
        && boundary.coverage.belowThresholdPixelCount > 0 && boundary.coverage.mixedHorizontalNeighborPairs > 0,
      noBoundaryControlsAreUniform: cases.slice(1).every((entry) => entry.coverage.mixedHorizontalNeighborPairs === 0),
      legacyBugReproduced: !boundary.legacyImplicitLod.blackWithinTolerance
        && boundary.legacyImplicitLod.aboveTolerancePixelCount > 0,
      // 不做散景时两种写法走同一条路径，必须都保持全黑；散景全开时的旧写法结果只记录不断言。
      legacyDisabledControlStaysBlack: cases[1].legacyImplicitLod.blackWithinTolerance,
      fixedAllCasesStayBlack: cases.every((entry) => entry.currentExplicitLod.blackWithinTolerance),
      bokehBranchEngaged: engagement.litPixelCount > 9 && engagement.maxDistance >= 6 && engagement.maxDistance <= 26 + 4,
      allReadbackValuesFinite: cases.every((entry) => entry.inputStats.nonFiniteValueCount === 0
        && entry.legacyImplicitLod.nonFiniteValueCount === 0 && entry.currentExplicitLod.nonFiniteValueCount === 0),
    };
    return { environment, width, height, hdrType: 'HalfFloat', mipmapsGenerated: true,
      tolerance, roi, roiPixelCount, cases, engagement, assertions, passed: Object.values(assertions).every(Boolean) };
  }, { shader, legacyShader });

  const report = {
    recordedAt: new Date().toISOString(), baseURL,
    browser: { product: 'Google Chrome', channel: 'chrome', headless: true, version: browser.version() },
    shaderPath: 'src/ocean/post.frag.glsl', shaderSha256: createHash('sha256').update(shader).digest('hex'),
    legacyMutation: 'Only the bokeh tap read changes from textureLod(uScene, vUv + offset * pixel, lod) to texture2D(uScene, vUv + offset * pixel).',
    method: '实际带mip的HDR输入，上部明亮天空、下部全黑海面；运行实际post shader后以Float32 framebuffer readback比较远离天空的黑区。',
    scope: '验证非一致CoC分支的LOD泄漏回归，不代替完整页面视觉或FPS验收。',
    ...result, errors, passed: result.passed && errors.length === 0,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, outputPath, assertions: report.assertions,
    cases: report.cases.map((entry) => ({ name: entry.name,
      legacyMax: entry.legacyImplicitLod.maxAbsoluteColor,
      legacyLeakedPixels: entry.legacyImplicitLod.aboveTolerancePixelCount,
      fixedMax: entry.currentExplicitLod.maxAbsoluteColor,
    })), engagement: report.engagement, errors }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser.close();
}

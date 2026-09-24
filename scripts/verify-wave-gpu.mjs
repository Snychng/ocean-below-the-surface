/**
 * 先在本案例运行 npm run dev，再执行 node scripts/verify-wave-gpu.mjs。
 * 使用独立系统 Google Chrome headless 实例，不打开或操作已有 UI 验收浏览器。
 * 默认服务 http://127.0.0.1:4188，可通过 OCEAN_BASE_URL 覆盖。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, '分析/reference-20260921/optimization-v9/wave-gpu-verification.json');
const baseURL = process.env.OCEAN_BASE_URL ?? 'http://127.0.0.1:4188';
const verificationURL = new URL('/__wave_gpu_verification__', baseURL).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  // 仅此独立页面返回空白壳；ES modules 仍由真实 Vite 开发服务提供。
  await page.route(verificationURL, (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(verificationURL);
  const result = await page.evaluate(async () => {
    const T = await import('/node_modules/three/build/three.module.js');
    const { createWaveSimulation } = await import('/src/ocean/WaveSimulation.js');
    const { createSpectrum, evolveSpectrumCPU } = await import('/src/ocean/spectrum.js');
    const renderer = new T.WebGLRenderer();
    renderer.setSize(640, 480);
    const preciseStorage = renderer.extensions.has('OES_texture_float_linear');
    const context = renderer.getContext();
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
    const environment = {
      userAgent: navigator.userAgent,
      webglVersion: context.getParameter(context.VERSION),
      gpuRenderer: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
      gpuVendor: debugInfo ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
    };
    const scene = new T.Scene();
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new T.PlaneGeometry(2, 2);
    const material = new T.ShaderMaterial({
      uniforms: { source: { value: null } },
      depthWrite: false, depthTest: false, toneMapped: false,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: 'uniform sampler2D source;varying vec2 vUv;void main(){gl_FragColor=texture2D(source,vUv);}',
    });
    scene.add(new T.Mesh(geometry, material));

    // 独立直接逆 DFT；不复用被测 GPU butterfly 实现。
    function inverseAt(coefficients, resolution, x, z) {
      let real = 0;
      for (let kz = 0; kz < resolution; kz += 1) {
        for (let kx = 0; kx < resolution; kx += 1) {
          const index = (kz * resolution + kx) * 2;
          const phase = 2 * Math.PI * (kx * x + kz * z) / resolution;
          real += coefficients[index] * Math.cos(phase) - coefficients[index + 1] * Math.sin(phase);
        }
      }
      return real;
    }

    function rendererState() {
      return {
        viewport: renderer.getViewport(new T.Vector4()).toArray(),
        scissor: renderer.getScissor(new T.Vector4()).toArray(),
        scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear,
        xrEnabled: renderer.xr.enabled, targetIsNull: renderer.getRenderTarget() === null,
      };
    }

    const configurations = [
      {
        name: 'float32-small-grid-reference',
        options: { resolution: 16, detailResolution: 16, ripple: { resolution: 16 }, storage: 'float' },
        times: [0, 0.37, 14.6], allPixels: true, maxAllowedErrorMeters: 0.00003,
      },
      {
        name: 'default-half-float', options: {}, times: [9.41],
        allPixels: false, maxAllowedErrorMeters: 0.008,
      },
      {
        name: 'current-render-parameters',
        options: {
          // 与 src/ocean/OceanRenderer.js 的 createWaveSimulation 参数保持一致。
          storage: preciseStorage ? 'float' : 'half', windDirection: [-0.24, 0.97],
          long: {
            length: 64, resolution: 512, rmsHeight: 0.11,
            windSpeed: 4.5, smallWaveDamping: 0.18, choppiness: 1.1, spreading: 3,
          },
          detail: {
            length: 8, resolution: 256, rmsHeight: 0.017,
            maxWavelength: 1.15, smallWaveDamping: 0.024, windSpeed: 3.2, choppiness: 0.38, spreading: 2,
          },
          ripple: { rmsHeight: 0.0042, maxWavelength: 0.25, smallWaveDamping: 0.012, spreading: 1 },
        },
        times: [9.41], allPixels: false, maxAllowedErrorMeters: preciseStorage ? 0.00003 : 0.008,
        maxAllowedErrorMetersByLayer: { ripple: preciseStorage ? 0.000001 : 0.00015 },
      },
    ];
    const runs = [];
    try {
      for (const configuration of configurations) {
        renderer.setRenderTarget(null);
        renderer.setViewport(7, 9, 600, 450);
        renderer.setScissor(11, 13, 590, 440);
        renderer.setScissorTest(true);
        renderer.autoClear = true;
        const expectedState = rendererState();
        const started = performance.now();
        const simulation = createWaveSimulation(renderer, configuration.options);
        const initializationMs = performance.now() - started;
        const initializationStatePreserved = JSON.stringify(rendererState()) === JSON.stringify(expectedState);
        const samples = [];
        const layerNames = configuration.options.ripple ? ['long', 'detail', 'ripple'] : ['long', 'detail'];
        const textures = {
          long: simulation.texture, detail: simulation.detailTexture, ripple: simulation.rippleTexture,
        };
        let updateStatePreserved = true;
        try {
          for (const timeSeconds of configuration.times) {
            const beforeUpdate = rendererState();
            simulation.update(timeSeconds);
            updateStatePreserved &&= JSON.stringify(rendererState()) === JSON.stringify(beforeUpdate);
            for (const layer of layerNames) {
              const parameters = simulation.parameters[layer];
              if (!parameters || !textures[layer]) throw new Error(`Missing expected ${layer} simulation output.`);
              const n = parameters.resolution;
              material.uniforms.source.value = textures[layer];
              const target = new T.WebGLRenderTarget(n, n, {
                type: T.FloatType, format: T.RGBAFormat, depthBuffer: false,
                stencilBuffer: false, colorSpace: T.NoColorSpace,
              });
              try {
                renderer.setRenderTarget(target);
                renderer.setScissorTest(false);
                renderer.render(scene, camera);
                const pixels = new Float32Array(n * n * 4);
                renderer.readRenderTargetPixels(target, 0, 0, n, n, pixels);
                const cpu = evolveSpectrumCPU(createSpectrum(parameters), timeSeconds);
                const coordinates = configuration.allPixels
                  ? Array.from({ length: n * n }, (_, index) => [index % n, Math.floor(index / n)])
                  : [[0, 0], [3, 7], [n - 1, n - 1], [Math.floor(n / 3), Math.floor(n / 5)]];
                let maxAbsoluteErrorMeters = 0;
                for (const [x, z] of coordinates) {
                  const index = (z * n + x) * 4;
                  ['height', 'displacementX', 'displacementZ'].forEach((field, channel) => {
                    maxAbsoluteErrorMeters = Math.max(maxAbsoluteErrorMeters,
                      Math.abs(pixels[index + channel] - inverseAt(cpu[field], n, x, z)));
                  });
                }
                let heightSquaredSum = 0;
                let maxAbsoluteHeightMeters = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                  heightSquaredSum += pixels[index] ** 2;
                  maxAbsoluteHeightMeters = Math.max(maxAbsoluteHeightMeters, Math.abs(pixels[index]));
                }
                samples.push({
                  layer, timeSeconds, parameters,
                  comparedPixelCount: coordinates.length,
                  comparedCoordinates: configuration.allPixels ? 'all' : coordinates,
                  comparedChannels: ['height', 'displacementX', 'displacementZ'],
                  maxAbsoluteErrorMeters,
                  maxAllowedErrorMeters: configuration.maxAllowedErrorMetersByLayer?.[layer]
                    ?? configuration.maxAllowedErrorMeters,
                  storage: textures[layer].type === T.FloatType ? 'Float32' : 'HalfFloat',
                  measuredRmsHeightMeters: Math.sqrt(heightSquaredSum / (n * n)),
                  maxAbsoluteHeightMeters,
                  allOutputValuesFinite: pixels.every(Number.isFinite),
                  linearFiltering: material.uniforms.source.value.magFilter === T.LinearFilter,
                });
              } finally {
                renderer.setRenderTarget(null);
                target.dispose();
              }
            }
          }
        } finally {
          simulation.dispose();
          simulation.dispose();
        }
        runs.push({
          name: configuration.name, initializationMs, initializationStatePreserved,
          updateStatePreserved, repeatedDisposeSucceeded: true,
          maxAllowedErrorMeters: configuration.maxAllowedErrorMeters, samples,
          passed: initializationStatePreserved && updateStatePreserved && samples.every((sample) =>
            sample.allOutputValuesFinite && sample.linearFiltering
            && sample.maxAbsoluteErrorMeters <= sample.maxAllowedErrorMeters
            && sample.maxAbsoluteHeightMeters > 0),
        });
      }
    } finally {
      geometry.dispose(); material.dispose(); renderer.dispose();
    }
    return { environment, runs };
  });
  const report = {
    recordedAt: new Date().toISOString(),
    browser: { product: 'Google Chrome', channel: 'chrome', headless: true, version: browser.version() },
    baseURL,
    method: '实际 WebGL2 GPU FFT，拷贝至 Float32 framebuffer 后 readRenderTargetPixels；与独立直接 CPU 逆 DFT 比较。',
    scope: '验证数值、有限值、输出过滤与渲染状态恢复；不代表视觉构图、动态观感或目标设备验收。',
    ...result, errors,
    passed: errors.length === 0 && result.runs.every((run) => run.passed),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, outputPath, runs: report.runs.map((run) => ({
    name: run.name, passed: run.passed,
    maxAbsoluteErrorMeters: Math.max(...run.samples.map((sample) => sample.maxAbsoluteErrorMeters)),
  })), errors }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser.close();
}

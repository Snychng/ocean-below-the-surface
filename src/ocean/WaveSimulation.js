import {
  BufferAttribute, BufferGeometry, DataTexture, FloatType, GLSL3,
  HalfFloatType, LinearFilter, Mesh, NearestFilter, NoBlending, NoColorSpace,
  OrthographicCamera, RawShaderMaterial, RepeatWrapping, RGBAFormat,
  Scene, Vector4, WebGLRenderTarget,
} from 'three';
import { createSpectrum, GRAVITY } from './spectrum.js';

const vertexShader = /* glsl */ `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const evolutionShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uInitial;
uniform float uTime;
uniform float uLength;
uniform float uGravity;
uniform float uChoppiness;
uniform int uResolution;
out vec4 fragColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  ivec2 frequency = ivec2(
    pixel.x < uResolution / 2 ? pixel.x : pixel.x - uResolution,
    pixel.y < uResolution / 2 ? pixel.y : pixel.y - uResolution
  );
  vec2 k = 6.283185307179586 * vec2(frequency) / uLength;
  float magnitude = length(k);
  float phase = sqrt(uGravity * magnitude) * uTime;
  float c = cos(phase), s = sin(phase);
  vec4 h0 = texelFetch(uInitial, pixel, 0);
  vec2 h = vec2((h0.x + h0.z) * c + (h0.y + h0.w) * s,
               (h0.y - h0.w) * c + (h0.z - h0.x) * s);
  vec2 direction = magnitude > 0.0 ? k / magnitude : vec2(0.0);
  if (pixel.x == uResolution / 2) direction.x = 0.0;
  if (pixel.y == uResolution / 2) direction.y = 0.0;
  direction *= uChoppiness;
  // 将两个实位移场组合为一个复场：F(Dx + i Dz)，只需一次复数 IFFT。
  vec2 displacement = vec2(-direction.x * h.y - direction.y * h.x,
                            direction.x * h.x - direction.y * h.y);
  fragColor = vec4(h, displacement);
}
`;

const butterflyShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uInput;
uniform int uStage;
uniform int uAxis;
uniform int uLog2Resolution;
out vec4 fragColor;
int reverseBits(int value) {
  int reversed = 0;
  for (int bit = 0; bit < 9; bit++) {
    if (bit >= uLog2Resolution) break;
    reversed = (reversed << 1) | (value & 1);
    value >>= 1;
  }
  return reversed;
}
vec2 multiplyComplex(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  int index = uAxis == 0 ? pixel.x : pixel.y;
  int span = 1 << (uStage + 1);
  int halfSpan = span >> 1;
  int localIndex = index % span;
  int offset = localIndex % halfSpan;
  int first = (index / span) * span + offset;
  int second = first + halfSpan;
  if (uStage == 0) {
    first = reverseBits(first);
    second = reverseBits(second);
  }
  ivec2 firstPixel = uAxis == 0 ? ivec2(first, pixel.y) : ivec2(pixel.x, first);
  ivec2 secondPixel = uAxis == 0 ? ivec2(second, pixel.y) : ivec2(pixel.x, second);
  vec4 a = texelFetch(uInput, firstPixel, 0);
  vec4 b = texelFetch(uInput, secondPixel, 0);
  float angle = 6.283185307179586 * float(offset) / float(span);
  vec2 twiddle = vec2(cos(angle), sin(angle));
  vec4 weighted = vec4(multiplyComplex(b.xy, twiddle), multiplyComplex(b.zw, twiddle));
  fragColor = a + (localIndex < halfSpan ? weighted : -weighted);
}
`;

const outputShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uInput;
out vec4 fragColor;
void main() {
  vec4 value = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  fragColor = vec4(value.x, value.z, value.w, 0.0);
}
`;

function material(fragmentShader, uniforms) {
  return new RawShaderMaterial({
    glslVersion: GLSL3, vertexShader, fragmentShader, uniforms,
    depthWrite: false, depthTest: false, blending: NoBlending, toneMapped: false,
  });
}

function renderTarget(resolution, type, name, filter = NearestFilter) {
  const target = new WebGLRenderTarget(resolution, resolution, {
    type, format: RGBAFormat,
    minFilter: filter, magFilter: filter,
    wrapS: RepeatWrapping, wrapT: RepeatWrapping,
    depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, colorSpace: NoColorSpace,
  });
  target.texture.name = name;
  return target;
}

/**
 * GPU FFT 深水海浪。输出纹理都是稳定引用，update() 原位更新。
 * 默认两层；传入 options.ripple 时增加独立第三层 rippleTexture / parameters.ripple。
 * 每层都按 worldXZ / parameters[层名].length 重复采样。
 * RGBA = [高度米, 水平位移 X 米, 水平位移 Z 米, 0]；无颜色空间转换。
 * UV 原点对应世界 (0,0)。高度场法线可用相邻 texel 的米制有限差分求得。
 * 默认 HalfFloat 输出使用硬件线性过滤，内部 FFT 始终最近邻。
 * 显式 FloatType 模式仅在 OES_texture_float_linear 可用时启用线性过滤。
 * 位移后的海面位置 = vec3(q.x + G, R, q.y + B)，q 为未位移参数坐标。
 */
export function createWaveSimulation(renderer, options = {}) {
  const gravity = options.gravity ?? GRAVITY;
  const longOptions = {
    resolution: options.resolution ?? 256,
    length: options.length ?? 128,
    rmsHeight: options.rmsHeight ?? 0.21,
    windSpeed: options.windSpeed ?? 6.5,
    windDirection: options.windDirection ?? [0.88, 0.47],
    smallWaveDamping: 0.12,
    choppiness: options.choppiness ?? 0.85,
    seed: options.seed ?? 12037,
    gravity, ...options.long,
  };
  const detailOptions = {
    resolution: options.detailResolution ?? 128,
    length: options.detailLength ?? 16,
    rmsHeight: 0.026,
    windSpeed: 3.2,
    windDirection: options.windDirection ?? [0.88, 0.47],
    smallWaveDamping: 0.025,
    maxWavelength: 5,
    choppiness: 0.65,
    seed: `${options.seed ?? 12037}-detail`,
    gravity, ...options.detail,
  };
  const layerOptions = [longOptions, detailOptions];
  if (options.ripple != null) {
    if (typeof options.ripple !== 'object' || Array.isArray(options.ripple)) {
      throw new TypeError('Wave ripple options must be an object.');
    }
    layerOptions.push({
      resolution: 128, length: 2, rmsHeight: 0.0018,
      windSpeed: 1.8,
      windDirection: options.windDirection ?? [0.88, 0.47],
      smallWaveDamping: 0.012, maxWavelength: 0.32, choppiness: 0.12,
      seed: `${options.seed ?? 12037}-ripple`,
      gravity, ...options.ripple,
    });
  }
  // 在分配 GPU 资源前验证所有层，避免可选层参数无效时泄漏前两层资源。
  const spectra = layerOptions.map(createSpectrum);
  const storageType = options.storage === 'float' ? FloatType : HalfFloatType;
  const outputFilter = storageType === HalfFloatType
    || renderer.extensions.has('OES_texture_float_linear') ? LinearFilter : NearestFilter;
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  const butterfly = material(butterflyShader, {
    uInput: { value: null }, uStage: { value: 0 },
    uAxis: { value: 0 }, uLog2Resolution: { value: 8 },
  });
  const output = material(outputShader, { uInput: { value: null } });
  const mesh = new Mesh(geometry, butterfly);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const layers = spectra.map((spectrum, index) => {
    const { resolution, length, choppiness, gravity: layerGravity } = spectrum.parameters;
    const initial = new DataTexture(spectrum.initialData, resolution, resolution, RGBAFormat, FloatType);
    initial.minFilter = NearestFilter;
    initial.magFilter = NearestFilter;
    initial.wrapS = RepeatWrapping;
    initial.wrapT = RepeatWrapping;
    initial.colorSpace = NoColorSpace;
    initial.generateMipmaps = false;
    initial.needsUpdate = true;
    initial.name = `ocean-spectrum-${index}`;
    const evolution = material(evolutionShader, {
      uInitial: { value: initial }, uTime: { value: 0 },
      uLength: { value: length }, uResolution: { value: resolution },
      uGravity: { value: layerGravity }, uChoppiness: { value: choppiness },
    });
    return {
      parameters: spectrum.parameters, initial, evolution,
      stages: Math.log2(resolution),
      ping: renderTarget(resolution, storageType, `ocean-fft-${index}-ping`),
      pong: renderTarget(resolution, storageType, `ocean-fft-${index}-pong`),
      output: renderTarget(resolution, storageType, `ocean-displacement-${index}`, outputFilter),
    };
  });
  const parameters = Object.freeze({
    algorithm: 'Phillips spectrum / radix-2 GPU inverse FFT',
    gravity, long: layers[0].parameters, detail: layers[1].parameters,
    ...(layers[2] ? { ripple: layers[2].parameters } : {}),
    length: layers[0].parameters.length, detailLength: layers[1].parameters.length,
    resolution: layers[0].parameters.resolution,
    detailResolution: layers[1].parameters.resolution,
    channels: Object.freeze(['height', 'displacementX', 'displacementZ', 'unused']),
  });
  let disposed = false;
  let previousTime = null;
  const viewport = new Vector4();
  const scissor = new Vector4();

  function draw(shader, target) {
    mesh.material = shader;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }

  function update(timeSeconds) {
    if (disposed) throw new Error('Cannot update a disposed ocean simulation.');
    if (!Number.isFinite(timeSeconds)) throw new RangeError('Wave time must be finite.');
    if (timeSeconds === previousTime) return;
    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    renderer.getViewport(viewport);
    renderer.getScissor(scissor);
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    const xrEnabled = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      for (const layer of layers) {
        layer.evolution.uniforms.uTime.value = timeSeconds;
        draw(layer.evolution, layer.ping);
        let source = layer.ping;
        let destination = layer.pong;
        butterfly.uniforms.uLog2Resolution.value = layer.stages;
        for (let axis = 0; axis < 2; axis += 1) {
          butterfly.uniforms.uAxis.value = axis;
          for (let stage = 0; stage < layer.stages; stage += 1) {
            butterfly.uniforms.uStage.value = stage;
            butterfly.uniforms.uInput.value = source.texture;
            draw(butterfly, destination);
            [source, destination] = [destination, source];
          }
        }
        output.uniforms.uInput.value = source.texture;
        draw(output, layer.output);
      }
      previousTime = timeSeconds;
    } finally {
      renderer.setRenderTarget(previousTarget, cubeFace, mipLevel);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xrEnabled;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    geometry.dispose();
    butterfly.dispose();
    output.dispose();
    for (const layer of layers) {
      layer.initial.dispose();
      layer.evolution.dispose();
      layer.ping.dispose();
      layer.pong.dispose();
      layer.output.dispose();
    }
  }

  try { update(0); } catch (error) { dispose(); throw error; }
  return {
    update, texture: layers[0].output.texture,
    detailTexture: layers[1].output.texture, parameters, dispose,
    ...(layers[2] ? { rippleTexture: layers[2].output.texture } : {}),
  };
}

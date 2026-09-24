import test from 'node:test';
import assert from 'node:assert/strict';
import { FloatType, HalfFloatType, Vector4 } from 'three';
import { createWaveSimulation } from '../src/ocean/WaveSimulation.js';
import {
  createSeededRandom, createSpectrum, deepWaterDispersion,
  evolveSpectrumCPU, phillipsDensity, waveNumber,
} from '../src/ocean/spectrum.js';

const TAU = Math.PI * 2;
function approximately(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
}

// 独立直接 DFT 参考，不复用 GPU butterfly；同时计算被丢弃的虚部以检查物理场实数性。
function inverseAt(coefficients, resolution, x, z) {
  let real = 0;
  let imaginary = 0;
  for (let kz = 0; kz < resolution; kz += 1) {
    for (let kx = 0; kx < resolution; kx += 1) {
      const index = (kz * resolution + kx) * 2;
      const angle = TAU * (kx * x + kz * z) / resolution;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      real += coefficients[index] * cosine - coefficients[index + 1] * sine;
      imaginary += coefficients[index] * sine + coefficients[index + 1] * cosine;
    }
  }
  return { real, imaginary };
}

test('deep-water dispersion obeys ω² = g|k| and wavelength-dependent phase speed', () => {
  approximately(deepWaterDispersion(0, 0), 0);
  for (const wavelength of [0.25, 1, 8, 128]) {
    const k = TAU / wavelength;
    const omega = deepWaterDispersion(k, 0);
    approximately(omega * omega, 9.81 * k, 1e-10);
    approximately(TAU / omega, Math.sqrt(TAU * wavelength / 9.81), 1e-12);
  }
  assert.ok(deepWaterDispersion(TAU / 16, 0) / (TAU / 16)
    > deepWaterDispersion(TAU / 2, 0) / (TAU / 2));
});

test('seeded spectra are repeatable and different seeds change the sea', () => {
  const options = { resolution: 16, seed: 'ocean-regression' };
  const first = createSpectrum(options);
  const second = createSpectrum(options);
  assert.deepEqual(first.initialData, second.initialData);
  assert.notDeepEqual(first.initialData, createSpectrum({ ...options, seed: 'other' }).initialData);
  const random = createSeededRandom(4);
  assert.ok(Array.from({ length: 1000 }, random).every((value) => value >= 0 && value < 1));
});

test('height and both horizontal displacement spectra remain Hermitian including Nyquist axes', () => {
  const resolution = 16;
  const spectrum = createSpectrum({ resolution, length: 16, smallWaveDamping: 0.001 });
  for (const time of [0, 0.37, 13.92, 1000]) {
    for (const coefficients of Object.values(evolveSpectrumCPU(spectrum, time))) {
      for (let z = 0; z < resolution; z += 1) {
        for (let x = 0; x < resolution; x += 1) {
          const index = (z * resolution + x) * 2;
          const mirror = (((resolution - z) % resolution) * resolution
            + (resolution - x) % resolution) * 2;
          approximately(coefficients[index], coefficients[mirror]);
          approximately(coefficients[index + 1], -coefficients[mirror + 1]);
        }
      }
    }
  }
});

test('independent inverse DFT produces real, finite, periodic world-space fields', () => {
  const resolution = 16;
  const spectrum = createSpectrum({ resolution, length: 16, rmsHeight: 0.23 });
  const fields = evolveSpectrumCPU(spectrum, 5.43);
  for (const coefficients of Object.values(fields)) {
    for (const [x, z] of [[0, 0], [3, 7], [9, 15], [15, 15]]) {
      const value = inverseAt(coefficients, resolution, x, z);
      assert.ok(Number.isFinite(value.real));
      approximately(value.imaginary, 0, 1e-12);
      approximately(inverseAt(coefficients, resolution, x + resolution, z).real, value.real);
      approximately(inverseAt(coefficients, resolution, x, z + resolution).real, value.real);
    }
  }
  approximately(fields.height[0], 0);
  approximately(fields.height[1], 0);
});

test('normalized spectrum retains requested time-averaged energy at different resolutions', () => {
  for (const resolution of [16, 32, 128, 256]) {
    const rmsHeight = 0.21;
    const { h0 } = createSpectrum({ resolution, rmsHeight });
    const energy = h0.reduce((sum, value) => sum + value * value, 0);
    approximately(2 * energy, rmsHeight * rmsHeight, 1e-12);
  }
});

test('two real displacement spectra can be packed into one complex IFFT without cross-talk', () => {
  const resolution = 16;
  const fields = evolveSpectrumCPU(createSpectrum({ resolution }), 1.82);
  const packed = new Float64Array(fields.height.length);
  for (let index = 0; index < packed.length; index += 2) {
    packed[index] = fields.displacementX[index] - fields.displacementZ[index + 1];
    packed[index + 1] = fields.displacementX[index + 1] + fields.displacementZ[index];
  }
  for (const [x, z] of [[0, 0], [5, 8], [13, 11]]) {
    const result = inverseAt(packed, resolution, x, z);
    approximately(result.real, inverseAt(fields.displacementX, resolution, x, z).real);
    approximately(result.imaginary, inverseAt(fields.displacementZ, resolution, x, z).real);
  }
});

test('zero amplitude creates a flat sea and malformed inputs fail early', () => {
  const flat = createSpectrum({ resolution: 16, rmsHeight: 0 });
  assert.ok(flat.initialData.every((value) => value === 0));
  for (const options of [
    { resolution: 127 }, { resolution: 1024 }, { length: 0 },
    { gravity: -1 }, { rmsHeight: Number.NaN }, { windDirection: [0, 0] },
    { windSpeed: 0 }, { choppiness: Number.POSITIVE_INFINITY },
    { smallWaveDamping: Number.NaN }, { maxWavelength: -2 },
  ]) assert.throws(() => createSpectrum(options), RangeError);
  assert.throws(() => evolveSpectrumCPU(flat, Number.NaN), RangeError);
  assert.equal(phillipsDensity(0, 0), 0);
  approximately(waveNumber(8, 16, 16), -Math.PI);
});

// 只检查资源生命周期与逐层提交；不假装此替身执行了 GLSL 或验证 GPU 输出。
function rendererRecorder() {
  let target = null;
  let scissorTest = false;
  const viewport = new Vector4(0, 0, 640, 480);
  const scissor = viewport.clone();
  const targets = new Set();
  const submissions = [];
  return {
    targets, submissions, autoClear: true, xr: { enabled: false },
    extensions: { has: () => true },
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    getViewport: (value) => value.copy(viewport),
    getScissor: (value) => value.copy(scissor),
    getScissorTest: () => scissorTest,
    setViewport: (value) => viewport.copy(value),
    setScissor: (value) => scissor.copy(value),
    setScissorTest: (value) => { scissorTest = value; },
    setRenderTarget: (value) => { target = value; if (value) targets.add(value); },
    render: (scene) => {
      const mesh = scene.children[0];
      submissions.push({
        target, material: mesh.material, geometry: mesh.geometry,
        initialTexture: mesh.material.uniforms.uInitial?.value,
        time: mesh.material.uniforms.uTime?.value,
      });
    },
  };
}

test('omitting ripple preserves the two-layer API and render-target allocation', () => {
  const renderer = rendererRecorder();
  const simulation = createWaveSimulation(renderer, { resolution: 8, detailResolution: 8 });
  assert.deepEqual(Object.keys(simulation).sort(), ['detailTexture', 'dispose', 'parameters', 'texture', 'update']);
  assert.equal('ripple' in simulation.parameters, false);
  assert.equal(renderer.targets.size, 6);
  assert.equal(renderer.submissions.filter((submission) => submission.initialTexture).length, 2);
  assert.equal(simulation.texture.type, HalfFloatType);
  assert.equal(simulation.detailTexture.type, HalfFloatType);
  simulation.dispose();
});

test('optional ripple has its own spectrum and shares storage, updates, and resource disposal', () => {
  const renderer = rendererRecorder();
  const simulation = createWaveSimulation(renderer, {
    resolution: 8, detailResolution: 8, storage: 'float', seed: 'third-layer', gravity: 9.8,
    ripple: { resolution: 16, length: 2, rmsHeight: 0.0018, maxWavelength: 0.32 },
  });
  assert.equal(renderer.targets.size, 9);
  assert.equal(simulation.parameters.ripple.seed, 'third-layer-ripple');
  assert.notEqual(simulation.parameters.ripple.seed, simulation.parameters.detail.seed);
  assert.equal(simulation.parameters.ripple.gravity, 9.8);
  assert.equal(simulation.parameters.ripple.length, 2);
  assert.equal(simulation.parameters.ripple.resolution, 16);
  assert.equal(simulation.parameters.ripple.rmsHeight, 0.0018);
  assert.equal(simulation.rippleTexture.image.width, 16);
  assert.ok([simulation.texture, simulation.detailTexture, simulation.rippleTexture]
    .every((texture) => texture.type === FloatType));
  const evolutionSubmissions = renderer.submissions.filter((submission) => submission.initialTexture);
  assert.equal(evolutionSubmissions.length, 3);
  assert.equal(new Set(evolutionSubmissions.map((submission) => submission.initialTexture)).size, 3);
  const rippleTexture = simulation.rippleTexture;
  renderer.submissions.length = 0;
  simulation.update(2.75);
  assert.deepEqual(renderer.submissions.filter((submission) => submission.initialTexture)
    .map((submission) => submission.time), [2.75, 2.75, 2.75]);
  assert.equal(simulation.rippleTexture, rippleTexture);
  const submittedCount = renderer.submissions.length;
  simulation.update(2.75);
  assert.equal(renderer.submissions.length, submittedCount);

  const resources = new Set(renderer.targets);
  for (const submission of renderer.submissions) {
    resources.add(submission.material);
    resources.add(submission.geometry);
    if (submission.initialTexture) resources.add(submission.initialTexture);
  }
  const disposals = new Map([...resources].map((resource) => [resource, 0]));
  for (const resource of resources) {
    resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
  }
  simulation.dispose();
  simulation.dispose();
  assert.ok([...disposals.values()].every((count) => count === 1));
});

test('invalid optional ripple is rejected before render resources are submitted', () => {
  for (const ripple of [{ resolution: 63 }, { rmsHeight: Number.NaN }, false]) {
    const renderer = rendererRecorder();
    assert.throws(() => createWaveSimulation(renderer, { resolution: 8, detailResolution: 8, ripple }));
    assert.equal(renderer.targets.size, 0);
    assert.equal(renderer.submissions.length, 0);
  }
});

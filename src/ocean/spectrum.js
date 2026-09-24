/**
 * 深水重力波的确定性频谱。单位：米、秒；频谱排列采用未 fftshift 的 DFT 顺序。
 * h0 的幅度已包含频率单元面积，GPU 逆变换因此使用“不除以 N²”的约定。
 */
export const GRAVITY = 9.81;
const TAU = Math.PI * 2;

export function createSeededRandom(seed = 12037) {
  let state = typeof seed === 'number' ? seed >>> 0 : 2166136261;
  if (typeof seed !== 'number') {
    for (const character of String(seed)) {
      state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
    }
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function waveNumber(index, resolution, length) {
  return TAU * (index < resolution / 2 ? index : index - resolution) / length;
}

export function deepWaterDispersion(kx, kz, gravity = GRAVITY) {
  return Math.sqrt(gravity * Math.hypot(kx, kz));
}

export function phillipsDensity(kx, kz, options = {}) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-10) return 0;
  const gravity = options.gravity ?? GRAVITY;
  const windSpeed = options.windSpeed ?? 6.5;
  const wind = options.windDirection ?? [0.88, 0.47];
  const windLength = Math.hypot(wind[0], wind[1]);
  const direction = (kx * wind[0] + kz * wind[1]) / (k * windLength);
  const largeWaveLength = windSpeed * windSpeed / gravity;
  const damping = options.smallWaveDamping ?? 0.12;
  // 少量逆风能量避免单向条纹；方向不对称提供传播方向，Hermitian 由演化式保证。
  // spreading 为 cos^(2s) 方向分布的 s；默认 1 保持原 cos² 形状，值越大波峰越长。
  const spreading = options.spreading ?? 1;
  const alignment = (0.12 + 0.88 * Math.abs(direction) ** (2 * spreading)) * (direction < 0 ? 0.18 : 1);
  let density = Math.exp(-1 / (k * largeWaveLength) ** 2)
    * alignment * Math.exp(-((k * damping) ** 2)) / k ** 4;
  if (options.maxWavelength) {
    density *= Math.exp(-((TAU / (k * options.maxWavelength)) ** 4));
  }
  return density;
}

export function createSpectrum(options = {}) {
  const resolution = options.resolution ?? 256;
  const length = options.length ?? 128;
  const gravity = options.gravity ?? GRAVITY;
  const rmsHeight = options.rmsHeight ?? 0.21;
  const windDirection = [...(options.windDirection ?? [0.88, 0.47])];
  const windSpeed = options.windSpeed ?? 6.5;
  const choppiness = options.choppiness ?? 0.85;
  const smallWaveDamping = options.smallWaveDamping ?? 0.12;
  const maxWavelength = options.maxWavelength ?? null;
  const spreading = options.spreading ?? 1;
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 512
    || (resolution & (resolution - 1)) !== 0) {
    throw new RangeError('Wave resolution must be a power of two from 8 to 512.');
  }
  if (![length, gravity, windSpeed].every((value) => Number.isFinite(value) && value > 0)
    || !Number.isFinite(rmsHeight) || rmsHeight < 0
    || !Number.isFinite(choppiness) || choppiness < 0
    || !Number.isFinite(smallWaveDamping) || smallWaveDamping < 0
    || !Number.isFinite(spreading) || spreading <= 0
    || (maxWavelength !== null && (!Number.isFinite(maxWavelength) || maxWavelength <= 0))
    || windDirection.length !== 2 || !windDirection.every(Number.isFinite)
    || Math.hypot(...windDirection) < 1e-10) {
    throw new RangeError('Wave dimensions, gravity, wind and amplitudes must be finite and valid.');
  }
  const parameters = Object.freeze({
    resolution, length, gravity, rmsHeight, windSpeed,
    choppiness, seed: options.seed ?? 12037,
    windDirection: Object.freeze(windDirection),
    smallWaveDamping, maxWavelength, spreading,
  });
  const random = createSeededRandom(parameters.seed);
  const h0 = new Float64Array(resolution * resolution * 2);
  const frequencyStep = TAU / length;
  let energy = 0;
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const offset = (z * resolution + x) * 2;
      const amplitude = Math.sqrt(phillipsDensity(
        waveNumber(x, resolution, length), waveNumber(z, resolution, length), parameters,
      ) / 2) * frequencyStep;
      const gaussianRadius = Math.sqrt(-2 * Math.log(Math.max(1e-12, random())));
      const phase = TAU * random();
      h0[offset] = amplitude * gaussianRadius * Math.cos(phase);
      h0[offset + 1] = amplitude * gaussianRadius * Math.sin(phase);
      energy += h0[offset] ** 2 + h0[offset + 1] ** 2;
    }
  }
  // 各行波能量之和给出时间平均方差。显式归一化让分辨率不会改变浪高。
  const scale = energy > 0 ? rmsHeight / Math.sqrt(2 * energy) : 0;
  for (let index = 0; index < h0.length; index += 1) h0[index] *= scale;
  const initialData = new Float32Array(resolution * resolution * 4);
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const output = (z * resolution + x) * 4;
      const source = (z * resolution + x) * 2;
      const mirror = (((resolution - z) % resolution) * resolution
        + (resolution - x) % resolution) * 2;
      initialData[output] = h0[source];
      initialData[output + 1] = h0[source + 1];
      initialData[output + 2] = h0[mirror];
      initialData[output + 3] = h0[mirror + 1];
    }
  }
  return { parameters, h0, initialData };
}

/** CPU 参考演化，用于检查频谱、Hermitian 对称和 GPU readback，非逐帧渲染路径。 */
export function evolveSpectrumCPU(spectrum, time) {
  if (!Number.isFinite(time)) throw new RangeError('Wave time must be finite.');
  const { resolution, length, gravity, choppiness } = spectrum.parameters;
  const height = new Float64Array(resolution * resolution * 2);
  const displacementX = new Float64Array(height.length);
  const displacementZ = new Float64Array(height.length);
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = (z * resolution + x) * 2;
      const mirror = (((resolution - z) % resolution) * resolution
        + (resolution - x) % resolution) * 2;
      const kx = waveNumber(x, resolution, length);
      const kz = waveNumber(z, resolution, length);
      const k = Math.hypot(kx, kz);
      const phase = deepWaterDispersion(kx, kz, gravity) * time;
      const cosine = Math.cos(phase);
      const sine = Math.sin(phase);
      const a = spectrum.h0[index];
      const b = spectrum.h0[index + 1];
      const c = spectrum.h0[mirror];
      const d = spectrum.h0[mirror + 1];
      // h0(k) exp(-i ωt) + conjugate(h0(-k)) exp(+i ωt).
      const real = (a + c) * cosine + (b + d) * sine;
      const imaginary = (b - d) * cosine + (c - a) * sine;
      height[index] = real;
      height[index + 1] = imaginary;
      // Nyquist 轴不能拥有奇对称导数，否则会破坏位移场的实数性。
      const factorX = k > 0 && x !== resolution / 2 ? choppiness * kx / k : 0;
      const factorZ = k > 0 && z !== resolution / 2 ? choppiness * kz / k : 0;
      displacementX[index] = -factorX * imaginary;
      displacementX[index + 1] = factorX * real;
      displacementZ[index] = -factorZ * imaginary;
      displacementZ[index + 1] = factorZ * real;
    }
  }
  return { height, displacementX, displacementZ };
}

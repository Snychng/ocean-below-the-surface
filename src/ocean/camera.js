// 世界坐标中的光源不随滚动移动；折射会改变它在照片上的投影。
// 仰角约 3.15°、方位约 24.5°：海面首屏太阳投影在参考图 1 的 (0.764,0.611)。
export const SUN_DIRECTION = Object.freeze([0.4141593656, 0.055, -0.9085411492]);
export const OPTICS = Object.freeze({ airIOR: 1, waterIOR: 1.333, gravity: 9.81 });
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// 镜头全程水平：光轴平行于海平面，不俯仰、不偏航，滚动只让眼点竖直下沉（2026-09-23 用户反馈）。
// 构图用移轴（lens shift）而非抬头：成像面整体下移 tan(9.6°)，地平线固定在画面 0.674（参考图 1 的 2/3 天空），
// 竖直线保持竖直。纯平移下无穷远的地平线在画面中不动，只有近处海面随高度变化。
// 代价：水下 Snell 太阳像仰角 ≥ 41.4°，高于画面上沿（约 33.3°），不再出现在画面内，只见右上方射入的光束。
// 水下主光位（2026-09-24 用户反馈）：着色器在空气中的太阳方向叠加远方日光晕（非物理的构图处理），
// 与半浸没时水面上的太阳同一画面位置，落在用户红框内（桌面比例约 (0.75, 0.61)）。
export const CAMERA_POSE = Object.freeze({ pitch: 0, yaw: 0, shift: Math.tan(0.168), fov: 52 });

// 半浸没使用球面罩（dome port）：射线从以眼点为球心的罩面出发，罩面与波面相交处即镜头水线。
// 眼点在局部涌浪上方 portEyeHeight，平静海面水线仰角 = -portEyeHeight/portRadius ≈ -3.2°，
// 水平镜头下位于画面约 0.731，比地平线低约 0.057（与参考图 2 水线和远海的间距一致）；波高变化使其上下起伏。
export const PORT = Object.freeze({ radius: 0.45, eyeHeight: 0.0254 });

// 薄透镜弥散圈：coc(px, 以 941px 高为基准) = aperture·|1/d − 1/focus|。
// 海面对焦远处（地平线在景深内），前景 1–2m 的碎光成 8–12px 散景；半浸没对焦浪面近处；水下对焦约 6m。
export const FOCUS = Object.freeze({
  surface: { distance: 15, aperture: 16 },
  half: { distance: 2.6, aperture: 7.5 },
  underwater: { distance: 6.5, aperture: 7 },
});

export function cameraAtProgress(progress) {
  const p = clamp(progress);
  // 前半程降到球面罩恰好骑在涌浪上的高度，后半程竖直潜入三米；朝向全程不变。
  const half = PORT.eyeHeight;
  const height = p < 0.5 ? 0.58 - (0.58 - half) * smoothstep(0, 0.5, p) : half - (3 + half) * smoothstep(0.5, 1, p);
  const { pitch, yaw, shift, fov } = CAMERA_POSE;
  return { height, pitch, yaw, shift, fov };
}

// 相机随局部涌浪起伏的权重；只在穿越水面附近启用，首屏与深水保持固定机位。
export const anchorWeight = (progress) => Math.sin(Math.PI * clamp(progress)) ** 8;

export function focusAtProgress(progress) {
  const p = clamp(progress);
  const { surface, half, underwater } = FOCUS;
  const a = smoothstep(0.18, 0.5, p), b = smoothstep(0.5, 0.82, p);
  const mix = (x, y, t) => x + (y - x) * t;
  const from = p < 0.5 ? surface : half, to = p < 0.5 ? half : underwater, t = p < 0.5 ? a : b;
  // 在屈光度（1/d）空间插值，焦点移动在视觉上均匀。
  const diopter = mix(1 / from.distance, 1 / to.distance, t);
  return { distance: 1 / diopter, aperture: mix(from.aperture, to.aperture, t) };
}

function unitDirection(direction) {
  const length = Math.hypot(...direction);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('Direction must have finite, nonzero length.');
  return direction.map((value) => value / length);
}

// 与 GLSL refract 一致：incident 指向界面，normal 朝向入射介质。
// 全反射没有透射光路，以 null 表示，不能把零向量当作另一颗太阳。
export function refractDirection(incident, normal, etaIncident = OPTICS.airIOR, etaTransmitted = OPTICS.waterIOR) {
  const i = unitDirection(incident);
  const n = unitDirection(normal);
  const eta = etaIncident / etaTransmitted;
  const ni = n.reduce((sum, value, index) => sum + value * i[index], 0);
  const discriminant = 1 - eta * eta * (1 - ni * ni);
  if (discriminant < 0) return null;
  const normalScale = eta * ni + Math.sqrt(discriminant);
  return unitDirection(i.map((value, index) => eta * value - normalScale * n[index]));
}

// direction 是空气中朝太阳的方向；返回水中朝太阳像的方向。
export function refractSunDirection(direction = SUN_DIRECTION, normal = [0, 1, 0]) {
  const transmitted = refractDirection(direction.map((value) => -value), normal);
  return transmitted?.map((value) => -value) ?? null;
}

// viewRay 的逆变换。yaw 为正时相机朝世界 +X 转向；shift 为成像面竖直移轴量（tan 单位，正值使画面看得更高）。
// 返回以视口左上角为原点的归一化坐标；允许太阳在视口外，背向相机则返回 null。
export function projectWorldDirection(direction, camera, aspect) {
  const [x, y, z] = unitDirection(direction);
  const yaw = camera.yaw ?? 0;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sp = Math.sin(camera.pitch), cp = Math.cos(camera.pitch);
  const viewX = x * cy + z * sy;
  const viewY = -x * sy * sp + y * cp + z * cy * sp;
  const depth = x * sy * cp + y * sp - z * cy * cp;
  if (depth <= 0) return null;
  const tangent = Math.tan(camera.fov * Math.PI / 360);
  const shift = camera.shift ?? 0;
  return { x: 0.5 + viewX / (2 * depth * tangent * aspect), y: 0.5 - (viewY / depth - shift) / (2 * tangent) };
}

export function fresnelDielectric(cosIncident, etaIncident = 1, etaTransmitted = 1.333) {
  const c = clamp(Math.abs(cosIncident));
  const sinT2 = (etaIncident / etaTransmitted) ** 2 * (1 - c * c);
  if (sinT2 >= 1) return 1;
  const ct = Math.sqrt(1 - sinT2);
  const rs = (etaIncident * c - etaTransmitted * ct) / (etaIncident * c + etaTransmitted * ct);
  const rp = (etaTransmitted * c - etaIncident * ct) / (etaTransmitted * c + etaIncident * ct);
  return (rs * rs + rp * rp) * 0.5;
}

export function damp(current, target, rate, dt) { return target + (current - target) * Math.exp(-rate * Math.min(dt, 0.1)); }

precision highp float;
uniform float uTime;
uniform float uYaw;
uniform float uProgress;
uniform vec2 uResolution;
uniform vec3 uCamera;
uniform float uPitch;
// 成像面竖直移轴量（tan 单位）：光轴保持水平，画面整体上移而不产生俯仰透视。
uniform float uShift;
uniform float uFov;
uniform vec3 uSunDirection;
uniform sampler2D uWaves;
uniform sampler2D uDetail;
uniform sampler2D uSky;
uniform sampler2D uCurvature;
uniform sampler2D uDetailCurvature;
uniform vec3 uLengths;
uniform vec3 uGrid;
uniform sampler2D uRipple;
uniform sampler2D uSurface;
uniform sampler2D uDetailSurface;
uniform sampler2D uRippleSurface;
// 球面罩半径、眼点随涌浪起伏的权重、单个渲染像素对应的视角（弧度）。
uniform float uPortRadius;
uniform float uAnchor;
uniform float uPixelAngle;
const float PI = 3.141592653589793;
const float IOR = 1.333;
// 日落光谱的 HDR 辐亮度：水上太阳与水下透射共享同一能量。
// 真实太阳角半径 0.265°；辐照度与旧版（0.005/0.012 软盘）保持相同，仅把能量收进真实尺寸。
const float SUN_INNER_RADIUS = .0036;
const float SUN_OUTER_RADIUS = .0052;
const float SUN_SOLID_ANGLE = PI * .5 * (SUN_INNER_RADIUS * SUN_INNER_RADIUS + SUN_OUTER_RADIUS * SUN_OUTER_RADIUS);
// 仰角约 3° 的太阳穿过约 15 倍大气质量，短波被 Rayleigh/气溶胶强烈消光，直射光呈金橙色
// （蓝光透过率不到红光的五分之一）；日面与闪点核心过曝发白，散景边缘才显出金色。
const vec3 SUN_IRRADIANCE = vec3(6350., 3500., 1050.) * (PI * .5 * (.005 * .005 + .012 * .012));
const vec3 SUN_RADIANCE = SUN_IRRADIANCE / SUN_SOLID_ANGLE;

// 各层的 mip 级别由世界空间足迹决定：足迹小于一个网格单元时取原始分辨率。
vec3 layerLod(float footprint) {
  return max(vec3(0.), log2(max(footprint, 1e-6) * uGrid / uLengths));
}
vec3 rawWave(vec2 p) {
  return textureLod(uWaves, p / uLengths.x, 0.).rgb + textureLod(uDetail, p / uLengths.y, 0.).rgb + textureLod(uRipple, p / uLengths.z, 0.).rgb;
}
// 共同位移只用于泡沫材质随波漂移；几何由各层 Eulerian 缓存相加。
vec2 materialCoordinate(vec2 p) {
  vec2 q=p;
  for(int i=0;i<3;i++)q=p-rawWave(q).gb*.82;
  return q;
}
float seaHeight(vec2 p) {
  return textureLod(uSurface,p/uLengths.x,0.).r+textureLod(uDetailSurface,p/uLengths.y,0.).r+textureLod(uRippleSurface,p/uLengths.z,0.).r;
}
// 求交用的足迹过滤高度：远处亚像素波纹按 mip 平均，不在地平线附近产生闪烁的根。
float seaHeight(vec2 p, float footprint) {
  vec3 lod = layerLod(footprint);
  return textureLod(uSurface,p/uLengths.x,lod.x).r+textureLod(uDetailSurface,p/uLengths.y,lod.y).r+textureLod(uRippleSurface,p/uLengths.z,lod.z).r;
}
vec3 waveNormal(vec2 p, float distanceToCamera) {
  vec3 lod = layerLod(distanceToCamera * uPixelAngle);
  vec2 slope=textureLod(uSurface,p/uLengths.x,lod.x).gb+textureLod(uDetailSurface,p/uLengths.y,lod.y).gb+textureLod(uRippleSurface,p/uLengths.z,lod.z).gb;
  return normalize(vec3(-slope.x,1.,-slope.y));
}
// 像素足迹在海面上的两条轴：横向为 t·像素角，沿视线方向按局部浪面的掠射程度拉长 1/(n·v)。
// 朝向相机的浪面几乎正对镜头，足迹接近圆形；只有平缓处才按平均海面的 1/|rd.y| 拉长。
// 用 textureGrad 交给各向异性过滤，远处波纹平均成粗糙度而不是走样成点阵。
vec4 layerGrad(sampler2D s, vec2 p, float L, vec2 ax, vec2 ay) {
  return textureGrad(s, p / L, ax / L, ay / L);
}
float footprintStretch(vec3 n, vec3 rd) {
  return min(1. / max(max(dot(n, -rd), abs(rd.y)), .02), 40.);
}
// minFootprint（米）：小于该尺度的浪不再作为已解析法线，而是并入 LEAN 斜率方差（总方差不变）。
vec3 filteredNormal(vec2 p, vec3 rd, float t, float minFootprint, out float variance) {
  float w = max(t * uPixelAngle, 1e-5);
  vec2 along = normalize(rd.xz + vec2(1e-5, 0.));
  vec2 across = vec2(-along.y, along.x);
  float stretch = footprintStretch(waveNormal(p, t), rd);
  vec2 ax = across * max(w, minFootprint), ay = along * max(w * stretch, minFootprint);
  vec4 a = layerGrad(uSurface, p, uLengths.x, ax, ay);
  vec4 b = layerGrad(uDetailSurface, p, uLengths.y, ax, ay);
  vec4 c = layerGrad(uRippleSurface, p, uLengths.z, ax, ay);
  // LEAN：各层独立，足迹内斜率方差 = E[|s|²] − |E[s]|²，直接加到微表面粗糙度上。
  variance = max(a.a - dot(a.gb, a.gb), 0.) + max(b.a - dot(b.gb, b.gb), 0.) + max(c.a - dot(c.gb, c.gb), 0.);
  vec2 slope = a.gb + b.gb + c.gb;
  return normalize(vec3(-slope.x, 1., -slope.y));
}
vec3 filteredNormal(vec2 p, vec3 rd, float t, out float variance) {
  return filteredNormal(p, rd, t, 0., variance);
}
vec3 cameraToWorld(vec3 ray) {
  vec3 pitched=vec3(ray.x,ray.y*cos(uPitch)-ray.z*sin(uPitch),ray.y*sin(uPitch)+ray.z*cos(uPitch));
  return vec3(pitched.x*cos(uYaw)-pitched.z*sin(uYaw),pitched.y,pitched.x*sin(uYaw)+pitched.z*cos(uYaw));
}
vec3 viewRay(vec2 uv) {
  vec2 xy = uv * 2. - 1.;
  xy.x *= uResolution.x / uResolution.y;
  return cameraToWorld(normalize(vec3(xy * tan(uFov * .5) + vec2(0., uShift), -1.)));
}
// 眼点骑在低通后的涌浪上（长浪 + 细浪的大尺度部分），小浪仍在罩面上起伏形成水线。
// 取罩面正前方的点：画面中央水线由此处水面决定，眼点下方的浪相位与之不同。
// 在着色器内求值，避免每帧 GPU→CPU 回读阻塞。
float anchorHeight() {
  vec3 forward = cameraToWorld(vec3(0., 0., -1.));
  vec2 p = uCamera.xz + normalize(forward.xz + vec2(1e-5, 0.)) * uPortRadius;
  return textureLod(uSurface, p / uLengths.x, 1.).r + textureLod(uDetailSurface, p / uLengths.y, 2.).r;
}
vec3 eyePosition() {
  return uCamera + vec3(0., uAnchor * anchorHeight(), 0.);
}
// 球面罩：以眼点为球心，射线垂直穿过罩面，不发生折射；水线是罩面与真实波面的交线。
vec3 lensPoint(vec2 uv) {
  return eyePosition() + viewRay(uv) * uPortRadius;
}
float lensSignedDistance(vec2 uv) {
  vec3 p = lensPoint(uv);
  return p.y - seaHeight(p.xz);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx)*.1031);
  p3 += dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

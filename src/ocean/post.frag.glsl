precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBright;
uniform vec2 uTexel;
uniform float uTime;
uniform float uProgress;
uniform vec3 uFocus;
const float GOLDEN_ANGLE = 2.39996323;
const int BOKEH_TAPS = 32;
const float PI_OVER_N = 3.14159265 / 32.;

// Stephen Hill 的 ACES 拟合（RRT+ODT），输入/输出矩阵在 sRGB 线性与 AP1 之间转换。
const mat3 ACES_INPUT = mat3(.59719, .07600, .02840, .35458, .90834, .13383, .04823, .01566, .83777);
const mat3 ACES_OUTPUT = mat3(1.60475, -.10208, -.00327, -.53108, 1.10813, -.07276, -.07367, -.00605, 1.07602);
vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + .0245786) - .000090537;
  vec3 b = v * (.983729 * v + .4329510) + .238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  return clamp(ACES_OUTPUT * rrtAndOdtFit(ACES_INPUT * c), 0., 1.);
}
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c));
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 以 gather 实现 scatter：每个采样点把自身辐亮度均匀摊到半径为其弥散圈的圆盘上，
// 采样点代表 πR²/N 的面积，因此贡献 = 颜色 · (R²/N) / coc²；未被覆盖的部分由中心像素补足。
// 这样散景亮度与光源能量守恒：极亮闪点散成圆盘时整体变暗、变大，而不是复制成一串亮点。
vec3 depthOfField(vec4 center) {
  float neighbourhood = max(textureLod(uScene, vUv, 4.).a * 1.3, textureLod(uScene, vUv, 2.5).a * 1.1);
  float radius = min(max(center.a, neighbourhood), uFocus.z);
  if(radius < .75) return center.rgb;
  float spacing = radius * sqrt(PI_OVER_N);
  float lod = max(log2(spacing * .75), 0.);
  vec2 pixel = uTexel;
  float rotation = hash(gl_FragCoord.xy) * GOLDEN_ANGLE;
  vec3 sum = vec3(0.);
  float coverage = 0.;
  for(int i = 0; i < BOKEH_TAPS; i++) {
    float fi = float(i) + .5;
    float r = radius * sqrt(fi / float(BOKEH_TAPS));
    float a = fi * GOLDEN_ANGLE + rotation;
    vec2 offset = vec2(cos(a), sin(a)) * r;
    vec4 tap = textureLod(uScene, vUv + offset * pixel, lod);
    float tapCoc = max(tap.a, .5);
    // 采样点的弥散圈必须覆盖到当前像素；边缘 1px 软化避免硬环。
    float covers = clamp(tapCoc - r + 1., 0., 1.);
    float w = covers * min(radius * radius / (tapCoc * tapCoc), float(BOKEH_TAPS)) / float(BOKEH_TAPS);
    sum += tap.rgb * w;
    coverage += w;
  }
  if(coverage >= 1.) return sum / coverage;
  return sum + center.rgb * (1. - coverage);
}

void main() {
  vec4 center = textureLod(uScene, vUv, 0.);
  vec3 c = depthOfField(center);
  // 镜头眩光：同一 HDR 场景的多级 mip 叠加成近似幂律的点扩散函数（核心窄、拖尾宽）。
  vec2 brightTexel = uTexel * 2.;
  vec3 glare = vec3(0.);
  float weights[6];
  weights[0] = .30; weights[1] = .24; weights[2] = .18; weights[3] = .13; weights[4] = .09; weights[5] = .06;
  for(int k = 0; k < 6; k++) {
    float lod = float(k + 1);
    vec2 d = brightTexel * exp2(lod) * .5;
    vec3 s = textureLod(uBright, vUv + vec2(d.x, d.y), lod).rgb + textureLod(uBright, vUv + vec2(-d.x, d.y), lod).rgb
           + textureLod(uBright, vUv + vec2(d.x, -d.y), lod).rgb + textureLod(uBright, vUv - d, lod).rgb;
    glare += s * .25 * weights[k];
  }
  // 大尺度杂散光（镜片与罩面的散射），让太阳周围整体泛起一层光幕。
  vec3 veil = textureLod(uBright, vUv, 7.).rgb * .5 + textureLod(uBright, vUv, 8.).rgb * .5;
  c += glare * .03 + veil * .003;
  float vignette = 1. - .12 * pow(length((vUv - .5) * vec2(.95, 1.)), 1.8);
  // 固定曝光：参考图的高光（太阳、闪点）都已过曝，由 ACES 肩部柔和压缩。
  float exposure = mix(1.35, 1.55, smoothstep(.5, 1., uProgress)) / .6;
  // 半浸没：渐变减光镜压暗水线以上一档（参考图 2 的水上水下平衡），等效于把水下曝光抬高一倍。
  // 滤镜固定在画面上，浪峰越过过渡带时水下部分随之变暗，与真实拍摄一致；只在穿越水面的一段滚动中使用。
  // 过渡带跟随水平镜头下的平静水线（画面 0.731，即 vUv.y≈0.27），略偏水线上方。
  float split = pow(sin(3.14159265 * clamp(uProgress, 0., 1.)), 6.);
  exposure *= mix(1., 2., split * smoothstep(.37, .23, vUv.y));
  vec3 mapped = srgbEncode(acesFitted(c * vignette * exposure));
  // 胶片颗粒 + 三角抖动，消除暗部渐变的色阶。
  float n0 = hash(gl_FragCoord.xy + fract(uTime) * 91.7), n1 = hash(gl_FragCoord.yx * 1.37 + fract(uTime * 1.3) * 53.1);
  mapped += (n0 + n1 - 1.) / 255.;
  gl_FragColor = vec4(mapped, 1.);
}

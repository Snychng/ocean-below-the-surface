precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uTexel;
// 镜头散射的源图：半分辨率 4×4 盒式下采样。不设硬阈值，所有辐亮度都参与眩光，
// 只对极亮像素做 Karis 式软限幅，避免单个闪点在 mip 金字塔中逐帧跳动。
vec3 soften(vec3 c) {
  float luma = dot(c, vec3(.2126, .7152, .0722));
  return c / (1. + luma / 1500.);
}
void main() {
  vec3 a = textureLod(uScene, vUv + uTexel * vec2(-1., -1.), 0.).rgb;
  vec3 b = textureLod(uScene, vUv + uTexel * vec2( 1., -1.), 0.).rgb;
  vec3 c = textureLod(uScene, vUv + uTexel * vec2(-1.,  1.), 0.).rgb;
  vec3 d = textureLod(uScene, vUv + uTexel * vec2( 1.,  1.), 0.).rgb;
  gl_FragColor = vec4(.25 * (soften(a) + soften(b) + soften(c) + soften(d)), 1.);
}

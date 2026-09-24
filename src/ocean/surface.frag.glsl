precision highp float;
varying vec2 vUv;
uniform sampler2D uInput;
uniform float uLength;
uniform float uGridSize;
float heightAt(vec2 uv){
  vec2 q=uv;
  for(int i=0;i<3;i++)q=uv-texture2D(uInput,q).gb*.82/uLength;
  return texture2D(uInput,q).r;
}
void main(){
  vec2 dx=vec2(1./uGridSize,0.),dz=dx.yx;
  float meter=uLength/uGridSize;
  float h=heightAt(vUv);
  vec2 slope=vec2(heightAt(vUv+dx)-heightAt(vUv-dx),heightAt(vUv+dz)-heightAt(vUv-dz))/(2.*meter);
  // a 通道存 |∇h|²：mip 平均后 E[|s|²]−|E[s]|² 即像素足迹内未解析的斜率方差（LEAN）。
  gl_FragColor=vec4(h,slope,dot(slope,slope));
}

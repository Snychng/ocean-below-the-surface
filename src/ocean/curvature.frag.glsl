precision highp float;
varying vec2 vUv;
uniform sampler2D uInput;
uniform float uLength;
uniform float uGridSize;
float heightAt(vec2 uv){return texture2D(uInput,uv).r;}
void main(){
  float e=max(uLength/uGridSize,.18);
  vec2 dx=vec2(e/uLength,0.),dz=dx.yx;
  float h=heightAt(vUv);
  float hxx=(heightAt(vUv+dx)+heightAt(vUv-dx)-2.*h)/(e*e);
  float hzz=(heightAt(vUv+dz)+heightAt(vUv-dz)-2.*h)/(e*e);
  float hxz=(heightAt(vUv+dx+dz)+heightAt(vUv-dx-dz)-heightAt(vUv+dx-dz)-heightAt(vUv-dx+dz))/(4.*e*e);
  gl_FragColor=vec4(hxx,hzz,hxz,h);
}

varying vec2 vUv;
void main() {
  float x=vUv.x;
  float lo=0.,hi=1.;
  for(int i=0;i<12;i++) {
    float m=(lo+hi)*.5;
    if(lensSignedDistance(vec2(x,m))>0.) hi=m; else lo=m;
  }
  float waterline=1.-(lo+hi)*.5;
  vec3 probe=rawWave(vec2((x-.5)*7.,-2.5));
  // a 通道回传实际眼点高度（含随涌浪起伏），供状态面板与测试读取。
  gl_FragColor=vec4(waterline,probe.r,probe.g,eyePosition().y);
}

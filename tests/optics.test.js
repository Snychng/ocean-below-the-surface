import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraAtProgress, CAMERA_POSE, PORT, SUN_DIRECTION, OPTICS, fresnelDielectric, refractDirection, refractSunDirection, projectWorldDirection, damp} from '../src/ocean/camera.js';

const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
const unit=(v)=>v.map(value=>value/Math.hypot(...v));
const negative=(v)=>v.map(value=>-value);

test('空气水界面正入射反射率约2.04%，掠射趋于1',()=>{
 assert.ok(Math.abs(fresnelDielectric(1)-.020373)<1e-5);
 assert.ok(fresnelDielectric(.00001)>.9999);
});
test('水下临界角约48.6度，越过临界角完全反射',()=>{
 assert.equal(fresnelDielectric(Math.cos(50*Math.PI/180),1.333,1),1);
 assert.ok(fresnelDielectric(Math.cos(40*Math.PI/180),1.333,1)<1);
});
test('相机在两屏内单调下潜且中点无跳变',()=>{
 let y=Infinity;
 for(let i=0;i<=1000;i++){
  const c=cameraAtProgress(i/1000);
  assert.ok(c.height<=y+1e-12); y=c.height;
  assert.ok(Number.isFinite(c.pitch));
  assert.ok(Number.isFinite(c.yaw));
 }
 assert.ok(Math.abs(cameraAtProgress(.5-1e-6).height-cameraAtProgress(.5+1e-6).height)<1e-7);
 assert.ok(cameraAtProgress(0).height>0);
 assert.ok(cameraAtProgress(1).height<-2);
 assert.equal(cameraAtProgress(0).height,.58);
 assert.equal(cameraAtProgress(.5).height,PORT.eyeHeight);
 assert.equal(cameraAtProgress(1).height,-3);
 assert.deepEqual(cameraAtProgress(-1),cameraAtProgress(0));
 assert.deepEqual(cameraAtProgress(2),cameraAtProgress(1));
});
test('滚动不会修改世界光源方向',()=>{
 const before=[...SUN_DIRECTION];
 for(const p of [0,.25,.5,.75,1]){
  const camera=cameraAtProgress(p);
  projectWorldDirection(SUN_DIRECTION,camera,1672/940);
  projectWorldDirection(refractSunDirection(),camera,1672/940);
 }
 assert.deepEqual(SUN_DIRECTION,before);
 assert.ok(Object.isFrozen(SUN_DIRECTION));
});
test('镜头全程水平：不俯仰、不偏航，滚动只让眼点竖直平移（2026-09-23 反馈）',()=>{
 assert.ok(Object.isFrozen(CAMERA_POSE));
 assert.equal(CAMERA_POSE.pitch,0);
 assert.equal(CAMERA_POSE.yaw,0);
 const horizonY=projectWorldDirection([0,0,-1],cameraAtProgress(0),1672/941).y;
 // 参考图 1：地平线约在 0.674，首屏约 2/3 天空。
 assert.ok(Math.abs(horizonY-.674)<.001);
 let previousHeight=Infinity;
 for(let i=0;i<=1000;i++){
  const camera=cameraAtProgress(i/1000);
  assert.deepEqual({...camera,height:0},{height:0,pitch:0,yaw:0,shift:CAMERA_POSE.shift,fov:52});
  assert.ok(camera.height<=previousHeight+1e-12); previousHeight=camera.height;
  for(const aspect of [1672/941,390/844]){
   // 纯平移：无穷远地平线在画面中不动，且保持水平。
   for(const x of [-1,0,.6]) assert.ok(Math.abs(projectWorldDirection([x,0,-1],camera,aspect).y-horizonY)<1e-12);
   // 无俯仰透视：同一竖直方向上的点投影在同一列，竖直线不汇聚。
   const column=[-.4,0,.3,.8].map(y=>projectWorldDirection([.3,y,-1],camera,aspect).x);
   for(const x of column) assert.ok(Math.abs(x-column[0])<1e-12);
  }
 }
 assert.deepEqual(cameraAtProgress(0),{height:.58,pitch:0,yaw:0,shift:CAMERA_POSE.shift,fov:52});
 assert.deepEqual(cameraAtProgress(.5),{height:PORT.eyeHeight,pitch:0,yaw:0,shift:CAMERA_POSE.shift,fov:52});
 assert.deepEqual(cameraAtProgress(1),{height:-3,pitch:0,yaw:0,shift:CAMERA_POSE.shift,fov:52});
});
test('同一太阳的空气/水中光路符合 Snell 定律并可逆',()=>{
 const sun=unit(SUN_DIRECTION);
 for(const normal of [[0,1,0],unit([.12,1,.03]),unit([-.08,1,-.1])]){
  const water=refractSunDirection(sun,normal);
  assert.ok(water);
  const airCos=dot(sun,normal),waterCos=dot(water,normal);
  const sinAir=Math.sqrt(Math.max(0,1-airCos*airCos));
  const sinWater=Math.sqrt(Math.max(0,1-waterCos*waterCos));
  assert.ok(Math.abs(OPTICS.airIOR*sinAir-OPTICS.waterIOR*sinWater)<1e-12);
  const recovered=refractDirection(water,negative(normal),OPTICS.waterIOR,OPTICS.airIOR);
  assert.ok(recovered);
  assert.ok(Math.hypot(...recovered.map((value,index)=>value-sun[index]))<1e-11);
 }
 const water=refractSunDirection();
 assert.ok(Math.abs(Math.asin(water[1])*180/Math.PI-41.491679)<1e-5);
});
test('超过临界角时不存在透射太阳方向',()=>{
 const theta=50*Math.PI/180;
 assert.equal(refractDirection([Math.sin(theta),Math.cos(theta),0],[0,-1,0],1.333,1),null);
});
test('同一世界太阳：海面投影在参考图 1 的太阳处；水平镜头下水下 Snell 太阳像在画面上沿之外',()=>{
 const above=projectWorldDirection(SUN_DIRECTION,cameraAtProgress(0),1672/941);
 assert.ok(Math.abs(above.x-.763005)<1e-5);
 assert.ok(Math.abs(above.y-.611805)<1e-5);
 const tangent=Math.tan(26*Math.PI/180);
 const topEdge=Math.atan(tangent+CAMERA_POSE.shift);
 const water=refractSunDirection();
 // Snell 太阳像仰角 41.49°（≥ 临界仰角 41.4°）高于画面上沿约 33.3°：水平镜头无法同时保留首屏构图与水下日面。
 assert.ok(Math.asin(water[1])>topEdge+.1);
 for(const aspect of [1984/1091,1672/941,1936/1066]){
  for(let i=500;i<=1000;i+=10){
   const projected=projectWorldDirection(water,cameraAtProgress(i/1000),aspect);
   assert.ok(projected&&Number.isFinite(projected.x)&&Number.isFinite(projected.y));
   assert.ok(projected.y<0,'水下太阳像应在画面上沿之外');
   assert.ok(projected.x>.5,'光束从右上方射入');
  }
 }
});
test('水下远方日光晕中心（空气中的太阳方向）在用户红框内，且全程不随下潜移动（2026-09-24 反馈）',()=>{
 // 红框：素材/海平面之下/20260924-水下光位反馈/01-水下光位应在远处.png，页面 1400×739 内的归一化范围。
 const box={xMin:.6057,xMax:.8129,yMin:.3775,yMax:.7185};
 for(const aspect of [1400/739,1672/941,1936/1066,1984/1091]){
  const reference=projectWorldDirection(SUN_DIRECTION,cameraAtProgress(.5),aspect);
  for(let i=500;i<=1000;i+=10){
   const glow=projectWorldDirection(SUN_DIRECTION,cameraAtProgress(i/1000),aspect);
   assert.ok(glow.x>=box.xMin&&glow.x<=box.xMax,`x=${glow.x}`);
   assert.ok(glow.y>=box.yMin&&glow.y<=box.yMax,`y=${glow.y}`);
   assert.ok(Math.abs(glow.x-reference.x)<1e-12&&Math.abs(glow.y-reference.y)<1e-12);
  }
 }
});
test('屏幕投影与相机视线互逆，背向相机的光源不伪装成可见太阳',()=>{
 for(const aspect of [1672/940,390/844])for(const p of [0,.5,.72,1]){
  const camera=cameraAtProgress(p);
  const sy=Math.sin(camera.yaw),cy=Math.cos(camera.yaw);
  const sp=Math.sin(camera.pitch),cp=Math.cos(camera.pitch);
  const right=[cy,0,sy],up=[-sy*sp,cp,cy*sp],forward=[sy*cp,sp,-cy*cp];
  const tangent=Math.tan(camera.fov*Math.PI/360);
  for(const uv of [[.5,.5],[.12,.83],[.9,.1]]){
   const viewX=(uv[0]*2-1)*tangent*aspect;
   const viewY=(1-uv[1]*2)*tangent+(camera.shift??0);
   const world=forward.map((value,index)=>value+right[index]*viewX+up[index]*viewY);
   const projected=projectWorldDirection(world,camera,aspect);
   assert.ok(Math.abs(projected.x-uv[0])<1e-12);
   assert.ok(Math.abs(projected.y-uv[1])<1e-12);
  }
  assert.equal(projectWorldDirection(negative(forward),camera,aspect),null);
 }
});
test('阻尼更新分两步与一步结果一致，不产生越界',()=>{
 const once=damp(0,1,6,.08);
 const twice=damp(damp(0,1,6,.04),1,6,.04);
 assert.ok(Math.abs(once-twice)<1e-12);
 assert.ok(once>0&&once<1);
});

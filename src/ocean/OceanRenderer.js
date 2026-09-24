import {
  WebGLRenderer, WebGLRenderTarget, ShaderMaterial, Scene, OrthographicCamera,
  Mesh, PlaneGeometry, Vector2, Vector3, TextureLoader, LinearFilter, FloatType,
  HalfFloatType, LinearMipmapLinearFilter, RepeatWrapping, NoColorSpace, NoToneMapping, ClampToEdgeWrapping,
} from 'three';
import { createWaveSimulation } from './WaveSimulation.js';
import { cameraAtProgress, focusAtProgress, anchorWeight, PORT, SUN_DIRECTION, clamp, damp } from './camera.js';
import common from './shared.glsl?raw';
import oceanFragment from './ocean.frag.glsl?raw';
import postFragment from './post.frag.glsl?raw';
import brightFragment from './bright.frag.glsl?raw';
import probeFragment from './probe.frag.glsl?raw';
import curvatureFragment from './curvature.frag.glsl?raw';
import surfaceFragment from './surface.frag.glsl?raw';
import waterlineFragment from './waterline.glsl?raw';

const vertex = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`;

export async function createOceanRenderer(canvas, { onFrame, onReady, onError } = {}) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  if (!renderer.extensions.has('EXT_color_buffer_float')) {
    renderer.dispose();
    throw new Error('This ocean requires WebGL 2 floating-point rendering.');
  }
  renderer.toneMapping = NoToneMapping;
  const params = new URLSearchParams(location.search);
  const highQuality = params.get('quality') === 'high';
  let sky;
  try { sky = await new TextureLoader().loadAsync(`${import.meta.env.BASE_URL}environment/sky-panorama.jpg`); }
  catch (error) { renderer.dispose(); throw error; }
  sky.colorSpace = NoColorSpace;
  sky.wrapS = sky.wrapT = ClampToEdgeWrapping;
  sky.minFilter = LinearMipmapLinearFilter;
  sky.generateMipmaps = true;
  sky.magFilter = LinearFilter;
  const preciseStorage=renderer.extensions.has('OES_texture_float_linear');
  // 风向几乎正对镜头（波向 +Z），浪脊横贯画面；较窄的方向谱让涌浪成列而不是碎成面条。
  // 细浪（rms 1.7cm、陡度 .38）与毛细层（4.2mm）是海面碎光与水下揉皱纹理之间的折中：再强则水下全反射斑块过大，再弱则海面发平发灰。
  const simulation = createWaveSimulation(renderer, {
    storage:preciseStorage?'float':'half', windDirection:[-0.24,0.97],
    long:{length:64,resolution:512,rmsHeight:.11,windSpeed:4.5,smallWaveDamping:.18,choppiness:1.1,spreading:3},
    detail:{length:8,resolution:256,rmsHeight:.017,maxWavelength:1.15,smallWaveDamping:.024,windSpeed:3.2,choppiness:.38,spreading:2},
    ripple:{rmsHeight:.0042,maxWavelength:.25,smallWaveDamping:.012,spreading:1},
  });
  const maxAnisotropy=renderer.capabilities.getMaxAnisotropy();
  const uniforms = {
    uYaw:{value:0},uTime: { value: 12 }, uProgress: { value: 0 },
    uResolution: { value: new Vector2(1,1) },
    uCamera: { value: new Vector3(0,.62,0) },
    uPitch: { value: 0 }, uShift: { value: 0 }, uFov: { value: 52*Math.PI/180 },
    uSunDirection: { value: new Vector3(...SUN_DIRECTION).normalize() },
    uWaves: { value: simulation.texture }, uDetail: { value: simulation.detailTexture },
    uRipple:{value:simulation.rippleTexture},uSky: { value: sky }, uLengths: { value: new Vector3(simulation.parameters.length,simulation.parameters.detailLength,simulation.parameters.ripple.length) },
    uGrid:{value:new Vector3(simulation.parameters.long.resolution,simulation.parameters.detail.resolution,simulation.parameters.ripple.resolution)},
    uPortRadius:{value:PORT.radius}, uAnchor:{value:0}, uPixelAngle:{value:.001},
    // 焦距（米）、光圈（渲染像素下的弥散圈系数）、弥散圈上限。
    uFocus:{value:new Vector3(11,17,24)},
  };
  const geometry = new PlaneGeometry(2,2);
  const camera = new OrthographicCamera(-1,1,1,-1,0,1);
  const scene = new Scene();
  const ocean = new ShaderMaterial({ vertexShader: vertex, fragmentShader: common+'\n'+oceanFragment.replace('void main() {',waterlineFragment+'\nvoid main() {'), uniforms, depthWrite:false, depthTest:false });
  const mesh = new Mesh(geometry,ocean);
  mesh.frustumCulled=false;
  scene.add(mesh);
  // 场景 HDR：rgb 为辐亮度，a 为以渲染像素计的弥散圈半径；mip 供散景采样。
  const target = new WebGLRenderTarget(1,1,{type:HalfFloatType,minFilter:LinearMipmapLinearFilter,magFilter:LinearFilter,generateMipmaps:true,depthBuffer:false});
  // 半分辨率亮度金字塔：镜头散射（bloom/眩光）从同一 HDR 场景的多级 mip 取得。
  const brightTarget = new WebGLRenderTarget(1,1,{type:HalfFloatType,minFilter:LinearMipmapLinearFilter,magFilter:LinearFilter,generateMipmaps:true,depthBuffer:false});
  const probeTarget = new WebGLRenderTarget(64,1,{type:FloatType,depthBuffer:false});
  const probe = new ShaderMaterial({vertexShader:vertex,fragmentShader:common+'\n'+probeFragment,uniforms,depthWrite:false,depthTest:false});
  const postUniforms={uScene:{value:target.texture},uBright:{value:brightTarget.texture},uTexel:{value:new Vector2(1,1)},uTime:uniforms.uTime,uProgress:uniforms.uProgress,uFocus:uniforms.uFocus};
  const bright = new ShaderMaterial({vertexShader:vertex,fragmentShader:brightFragment,uniforms:postUniforms,depthWrite:false,depthTest:false});
  const post = new ShaderMaterial({vertexShader:vertex,fragmentShader:postFragment,uniforms:postUniforms,depthWrite:false,depthTest:false});
  const curvatureTargets=[simulation.parameters.long,simulation.parameters.detail].map(p=>new WebGLRenderTarget(p.resolution,p.resolution,{type:HalfFloatType,minFilter:LinearMipmapLinearFilter,magFilter:LinearFilter,generateMipmaps:true,wrapS:RepeatWrapping,wrapT:RepeatWrapping,depthBuffer:false}));
  const curvatureMaterial=new ShaderMaterial({vertexShader:vertex,fragmentShader:curvatureFragment,uniforms:{uInput:{value:null},uLength:{value:1},uGridSize:{value:256}},depthWrite:false,depthTest:false});
  uniforms.uCurvature={value:curvatureTargets[0].texture};
  uniforms.uDetailCurvature={value:curvatureTargets[1].texture};
  const waveLayers=[simulation.parameters.long,simulation.parameters.detail,simulation.parameters.ripple];
  const waveTextures=[simulation.texture,simulation.detailTexture,simulation.rippleTexture];
  // 波面缓存带 mip 与各向异性过滤：远处斜率按像素足迹平均，a 通道的 |∇h|² 给出未解析方差。
  const surfaceTargets=waveLayers.map(p=>new WebGLRenderTarget(p.resolution,p.resolution,{type:preciseStorage?FloatType:HalfFloatType,minFilter:LinearMipmapLinearFilter,magFilter:LinearFilter,generateMipmaps:true,anisotropy:maxAnisotropy,wrapS:RepeatWrapping,wrapT:RepeatWrapping,depthBuffer:false}));
  const surfaceMaterial=new ShaderMaterial({vertexShader:vertex,fragmentShader:surfaceFragment,uniforms:{uInput:{value:null},uLength:{value:1},uGridSize:{value:256}},depthWrite:false,depthTest:false});
  ['uSurface','uDetailSurface','uRippleSurface'].forEach((key,i)=>{uniforms[key]={value:surfaceTargets[i].texture};});
  const probePixels = new Float32Array(64*4);
  let progress = clamp(Number(params.get('p') ?? 0));
  let forcedProgress = params.has('p') ? progress : null;
  let time = Number(params.get('time') ?? 12);
  if(!Number.isFinite(time)) time=12;
  const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
  let paused = params.get('paused') === '1';
  let disposed=false, frameHandle=0, frameNumber=0, lastTimestamp=0, callbackTick=0;
  let previousProgress=-1, previousTime=-1, fps=60, lastAdapt=0;
  let pixelScale=1, width=1, height=1;
  let drift={x:0,y:0,rotation:0};
  let syncProbe=false;
  const waterline=new Array(64).fill(1);
  const state={ready:false,progress,time,fps,renderedFrames:0,waterline,drift,immersion:0,cameraHeight:.62,parameters:simulation.parameters,sunDirection:uniforms.uSunDirection.value.toArray(),errors:[]};
  renderer.debug.onShaderError=(gl,program,vs,fs)=>{
    const message=[gl.getProgramInfoLog(program),gl.getShaderInfoLog(vs),gl.getShaderInfoLog(fs)].filter(Boolean).join('\n');
    state.errors.push(message);
    onError?.(message);
    console.error('Ocean shader compilation failed',message);
  };

  function resize(){
    width=Math.max(1,window.innerWidth);height=Math.max(1,window.innerHeight);
    const budget=highQuality?4200000:1400000;
    pixelScale=Math.min(Math.max(devicePixelRatio,1.25),highQuality?2:1.5,Math.sqrt(budget/(width*height)));
    applySize();
  }
  function applySize(){
    renderer.setPixelRatio(pixelScale);
    renderer.setSize(width,height,false);
    target.setSize(Math.round(width*pixelScale),Math.round(height*pixelScale));
    brightTarget.setSize(Math.max(1,Math.round(target.width/2)),Math.max(1,Math.round(target.height/2)));
    postUniforms.uTexel.value.set(1/target.width,1/target.height);
    uniforms.uResolution.value.set(width,height);
    previousProgress=-1;
    state.resolution=[target.width,target.height];
    state.pixelScale=pixelScale;
  }
  function getScrollProgress(){return clamp(window.scrollY/Math.max(1,document.documentElement.scrollHeight-window.innerHeight));}
  let probePending=false, probeGeneration=0;
  const asyncProbePixels=new Float32Array(64*4);
  const gl=renderer.getContext();
  function renderProbe(){
    mesh.material=probe;
    renderer.setRenderTarget(probeTarget);
    renderer.render(scene,camera);
  }
  // 实时帧用异步回读（fence + PBO），不让 CPU 等待 GPU；截图/调试 API 用同步回读保证同帧。
  // three 在等待期间保持 PBO 绑定，发起后立即解绑；同步回读会作废仍在途中的旧结果。
  function updateProbe(sync=false){
    if(sync){
      probeGeneration++;
      renderProbe();renderer.readRenderTargetPixels(probeTarget,0,0,64,1,probePixels);applyProbe();return;
    }
    if(probePending)return;
    renderProbe();
    probePending=true;
    const generation=probeGeneration;
    renderer.readRenderTargetPixelsAsync(probeTarget,0,0,64,1,asyncProbePixels).then(()=>{
      probePending=false;
      if(disposed||generation!==probeGeneration)return;
      probePixels.set(asyncProbePixels);applyProbe();
    },()=>{probePending=false;});
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
  }
  function applyProbe(){
    let amount=0;
    for(let i=0;i<64;i++) {waterline[i]=clamp(probePixels[i*4]);amount+=1-waterline[i];}
    const center=32*4;
    const desired={x:probePixels[center+2]*14,y:probePixels[center+1]*15,rotation:(probePixels[40*4+1]-probePixels[24*4+1])*.85};
    drift={x:damp(drift.x,desired.x,8,.066),y:damp(drift.y,desired.y,8,.066),rotation:damp(drift.rotation,desired.rotation,8,.066)};
    state.immersion=amount/64;
    state.drift=drift;
    state.cameraHeight=probePixels[3];
  }
  function renderFrame(){
    simulation.update(time);
    mesh.material=surfaceMaterial;
    for(let i=0;i<3;i++){
      surfaceMaterial.uniforms.uInput.value=waveTextures[i];
      surfaceMaterial.uniforms.uLength.value=waveLayers[i].length;
      surfaceMaterial.uniforms.uGridSize.value=waveLayers[i].resolution;
      renderer.setRenderTarget(surfaceTargets[i]);renderer.render(scene,camera);
    }
    mesh.material=curvatureMaterial;
    for(let i=0;i<2;i++){
      const p=waveLayers[i];
      curvatureMaterial.uniforms.uInput.value=surfaceTargets[i].texture;
      curvatureMaterial.uniforms.uLength.value=p.length;
      curvatureMaterial.uniforms.uGridSize.value=p.resolution;
      renderer.setRenderTarget(curvatureTargets[i]);renderer.render(scene,camera);
    }
    const c=cameraAtProgress(progress);
    const focus=focusAtProgress(progress);
    uniforms.uTime.value=time;
    uniforms.uProgress.value=progress;
    uniforms.uPitch.value=c.pitch;
    uniforms.uYaw.value=c.yaw;
    uniforms.uShift.value=c.shift;
    uniforms.uCamera.value.set(0,c.height,0);
    uniforms.uFov.value=c.fov*Math.PI/180;
    uniforms.uPixelAngle.value=2*Math.tan(uniforms.uFov.value/2)/target.height;
    // 相机穿过水面时骑在涌浪上（着色器内求值），避免同一滚动进度被整片浪吞没。
    uniforms.uAnchor.value=anchorWeight(progress);
    const cocScale=target.height/941;
    uniforms.uFocus.value.set(focus.distance,focus.aperture*cocScale,26*cocScale);
    mesh.material=ocean;
    renderer.setRenderTarget(target);
    renderer.render(scene,camera);
    mesh.material=bright;
    renderer.setRenderTarget(brightTarget);
    renderer.render(scene,camera);
    mesh.material=post;
    renderer.setRenderTarget(null);
    renderer.render(scene,camera);
    if(frameNumber%4===0 || previousProgress<0) updateProbe(syncProbe);
    renderer.setRenderTarget(null);
    previousProgress=progress;previousTime=time;
    state.progress=progress;state.time=time;state.fps=fps;
    state.renderedFrames++;
    if(callbackTick++%4===0) onFrame?.({...state});
    if(!state.ready && state.errors.length===0){state.ready=true;onFrame?.({...state});onReady?.();}
  }
  function animate(timestamp){
    if(disposed)return;
    const dt=lastTimestamp?Math.min((timestamp-lastTimestamp)/1000,.1):1/60;
    lastTimestamp=timestamp;
    if(!document.hidden){
      fps=damp(fps,1/Math.max(dt,.001),2,dt);
      const targetProgress=forcedProgress??getScrollProgress();
      progress=motionPreference.matches?targetProgress:damp(progress,targetProgress,6.5,dt);
      if(Math.abs(progress-targetProgress)<.0001)progress=targetProgress;
      if(!paused)time+=dt;
      if(previousTime!==time||Math.abs(previousProgress-progress)>.00001)renderFrame();
      if(!highQuality&&frameNumber>100&&timestamp-lastAdapt>3500&&fps<29&&pixelScale>.55){
        pixelScale=Math.max(.55,pixelScale*.88);applySize();lastAdapt=timestamp;
      }
      frameNumber++;
    }
    frameHandle=requestAnimationFrame(animate);
  }
  function onContextLost(event){event.preventDefault();paused=true;onError?.('The graphics context was interrupted. Reload to reconnect to the ocean.');}
  canvas.addEventListener('webglcontextlost',onContextLost);
  window.addEventListener('resize',resize);
  resize();
  frameHandle=requestAnimationFrame(animate);
  const api={
    state,
    setPaused(value){paused=Boolean(value);},
    get paused(){return paused;},
    setProgress(value){forcedProgress=value==null?null:clamp(value);},
    setTime(value){if(Number.isFinite(value)){time=value;previousTime=-1;}},
    renderAt(value,seconds=time){progress=clamp(value);forcedProgress=progress;time=seconds;previousProgress=-1;syncProbe=true;renderFrame();syncProbe=false;onFrame?.({...state});},
    dispose(){
      disposed=true;cancelAnimationFrame(frameHandle);
      window.removeEventListener('resize',resize);canvas.removeEventListener('webglcontextlost',onContextLost);
      surfaceMaterial.dispose();surfaceTargets.forEach(t=>t.dispose());simulation.dispose();sky.dispose();ocean.dispose();post.dispose();bright.dispose();brightTarget.dispose();probe.dispose();curvatureMaterial.dispose();curvatureTargets.forEach(t=>t.dispose());target.dispose();probeTarget.dispose();geometry.dispose();renderer.dispose();
      if(window.__ocean===api)delete window.__ocean;
    },
  };
  window.__ocean=api;
  return api;
}

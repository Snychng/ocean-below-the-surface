import { useEffect, useRef } from 'react';

export default function OceanCanvas({paused,onFrame,onReady,onError}) {
  const canvasRef=useRef(null);
  const rendererRef=useRef(null);
  const callbacksRef=useRef({onFrame,onReady,onError});
  callbacksRef.current={onFrame,onReady,onError};
  const pausedRef=useRef(paused);
  pausedRef.current=paused;
  useEffect(()=>{
    let cancelled=false;
    import('../ocean/OceanRenderer.js').then(({createOceanRenderer})=>cancelled?null:createOceanRenderer(canvasRef.current,{
      onFrame:(frame)=>{if(!cancelled)callbacksRef.current.onFrame?.(frame);},
      onReady:()=>{if(!cancelled)callbacksRef.current.onReady?.();},
      onError:(message)=>{if(!cancelled)callbacksRef.current.onError?.(message);},
    })).then((renderer)=>{
      if(!renderer)return;
      if(cancelled){renderer.dispose();return;}
      rendererRef.current=renderer;
      renderer.setPaused(pausedRef.current);
    }).catch((error)=>{if(!cancelled){console.error(error);callbacksRef.current.onError?.(error.message);}});
    return()=>{cancelled=true;rendererRef.current?.dispose();rendererRef.current=null;};
  },[]);
  useEffect(()=>{rendererRef.current?.setPaused(paused);},[paused]);
  return <canvas ref={canvasRef} className="ocean-canvas" aria-label="A live ocean, from a sunset above the waves to the sunlit water below" role="img"/>;
}

// 水下固定时刻测量：隐藏界面只截画布，报告最亮光区的位置与碎光统计。需要 4188 上的开发服务。
// v8 起镜头水平，Snell 太阳像在画面上沿之外；v9 在空气中的太阳方向叠加远方日光晕，主光位回到右侧中部（用户红框）。
// node scripts/measure-underwater.mjs <输出子目录> [times=12,20,31,40,52]
// 光斑：画布缩到 96px 宽、σ2 模糊后，取 x ≥ 0.35 的最亮点（peak）与最亮 2.5% 的亮度加权质心（centroid）。
// 碎光：968px 宽灰度中比 σ10 局部均值亮 28 级以上的像素比例（brightFrac），及其中的 3×3 局部极大值（peaks）。
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
const [name='after',times='12,20,31,40,52']=process.argv.slice(2);
const W=1936,H=1066;
const REGIONS={all:[0,1,0,1],leftBand:[0,.55,.3,.8],belowSun:[.55,1,.65,1]};
const dest=fileURLToPath(new URL(`../分析/reference-20260921/optimization-v9/${name}/`,import.meta.url));
// 不覆盖已有证据：输出目录必须为空或不存在。
if((await readdir(dest).catch(()=>[])).length)throw new Error(`${dest} 非空，请指定新的子目录`);
await mkdir(dest,{recursive:true});
const gray=(file,w,h,filter='')=>execFileSync('ffmpeg',['-loglevel','error','-i',file,'-vf',`scale=${w}:${h}:flags=area,format=gray${filter}`,'-f','rawvideo','-']);
function sunGlow(file){
 const w=96,h=Math.round(96*H/W);
 const raw=execFileSync('ffmpeg',['-loglevel','error','-i',file,'-vf',`scale=${w}:${h}:flags=area,gblur=sigma=2`,'-f','rawvideo','-pix_fmt','rgb24','-']);
 const right=[];
 for(let y=0;y<h;y++)for(let x=Math.ceil(w*.35);x<w;x++){const i=(y*w+x)*3;right.push([.2126*raw[i]+.7152*raw[i+1]+.0722*raw[i+2],(x+.5)/w,(y+.5)/h]);}
 right.sort((a,b)=>a[0]-b[0]);
 const peak=right.at(-1),top=right.slice(-Math.floor(right.length/40)),sum=top.reduce((a,v)=>a+v[0],0);
 const round=v=>+v.toFixed(3);
 return {peak:[round(peak[1]),round(peak[2])],centroid:[round(top.reduce((a,v)=>a+v[0]*v[1],0)/sum),round(top.reduce((a,v)=>a+v[0]*v[2],0)/sum)]};
}
function specks(file){
 const w=968,h=Math.round(w*H/W),raw=gray(file,w,h),blur=gray(file,w,h,',gblur=sigma=10'),out={};
 for(const [key,[x0,x1,y0,y1]]of Object.entries(REGIONS)){
  let n=0,bright=0,peaks=0;
  for(let y=Math.max(1,Math.floor(y0*h));y<Math.min(h-1,Math.floor(y1*h));y++)for(let x=Math.max(1,Math.floor(x0*w));x<Math.min(w-1,Math.floor(x1*w));x++){
   const i=y*w+x,v=raw[i];n++;
   if(v-blur[i]<=28)continue;
   bright++;
   let isPeak=true;
   for(let dy=-1;dy<=1&&isPeak;dy++)for(let dx=-1;dx<=1;dx++)if((dx||dy)&&raw[i+dy*w+dx]>v){isPeak=false;break;}
   if(isPeak)peaks++;
  }
  out[key]={brightFrac:+(bright/n).toFixed(4),peaks};
 }
 return out;
}
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto('http://localhost:4188/');
await page.waitForFunction(()=>window.__ocean?.state.ready,{timeout:60000});
await page.addStyleTag({content:'*{visibility:hidden !important} canvas{visibility:visible !important}'});
await page.evaluate(()=>window.__ocean.setPaused(true));
const frames=[];
for(const t of times.split(',').map(Number)){
 await page.evaluate(t=>window.__ocean.renderAt(1,t),t);
 await page.waitForTimeout(120);
 const file=`${dest}t${t}.png`;
 await page.screenshot({path:file});
 frames.push({time:t,file:`t${t}.png`,...sunGlow(file),specks:specks(file)});
}
const result={recordedAt:new Date().toISOString(),viewport:[W,H],progress:1,regions:REGIONS,
 frames,state:await page.evaluate(()=>({resolution:window.__ocean.state.resolution,errors:window.__ocean.state.errors})),errors};
await writeFile(dest+'measurements.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.frames.map(({time,peak,centroid,specks})=>({time,peak,centroid,leftBand:specks.leftBand}))));
await browser.close();

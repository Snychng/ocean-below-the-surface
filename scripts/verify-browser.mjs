import {chromium} from 'playwright';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const base=process.env.OCEAN_URL??'http://localhost:4188/';
const dest=fileURLToPath(new URL('../分析/reference-20260921/optimization-v9/browser/',import.meta.url));
await mkdir(dest,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
// 录屏须经用户确认后以 OCEAN_RECORD=1 显式开启；默认只做截图与断言。
const record=process.env.OCEAN_RECORD==='1';
const context=await browser.newContext({viewport:{width:1672,height:941},deviceScaleFactor:1,...(record?{recordVideo:{dir:dest,size:{width:1672,height:941}}}:{})});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const checks=[];
const note=(name,data)=>{checks.push({name,pass:true,...data});console.log(name,JSON.stringify(data??{}));};
const snapshot=()=>page.evaluate(()=>({progress:window.__ocean.state.progress,immersion:window.__ocean.state.immersion,time:window.__ocean.state.time,frames:window.__ocean.state.renderedFrames,sun:window.__ocean.state.sunDirection,drift:window.__ocean.state.drift,resolution:window.__ocean.state.resolution,errors:window.__ocean.state.errors}));
async function waitReady(){await page.waitForFunction(()=>window.__ocean?.state.ready,{timeout:60000});}
async function performanceSample(){const start=await snapshot();const t=Date.now();await page.waitForTimeout(3000);const end=await snapshot();const renderedFps=(end.frames-start.frames)/((Date.now()-t)/1000);assert.ok(renderedFps>=24,`24 FPS minimum, measured ${renderedFps.toFixed(2)}`);return {renderedFps,resolution:end.resolution};}
try{
 await page.goto(base);await waitReady();await page.waitForTimeout(500);
 assert.equal(await page.locator('h1').count(),1);
 assert.ok(await page.evaluate(()=>Math.abs(document.documentElement.scrollHeight/innerHeight-2)<.02));
 const top=await snapshot();assert.ok(top.immersion<.02);
 note('two-screen document and dry first frame',top);
 await page.screenshot({path:dest+'01-above.png'});
 note('above live performance',await performanceSample());
 const moving=await snapshot();assert.ok(moving.time>top.time+1);assert.ok(moving.frames>top.frames+8);
 // 真实滚轮移动半个屏幕，不用渲染器调试 API 代替滚动链路。
 await page.mouse.wheel(0,470);await page.waitForTimeout(1800);
 const half=await snapshot();assert.ok(half.progress>.47&&half.progress<.53);assert.ok(half.immersion>.12&&half.immersion<.88);
 note('wheel reaches mixed air/water lens',half);await page.screenshot({path:dest+'02-half.png'});
 note('half live performance',await performanceSample());
 await page.getByRole('button',{name:'Explore now',exact:true}).click();
 await page.waitForFunction(()=>window.__ocean.state.progress>.99);
 await page.waitForTimeout(700);
 const below=await snapshot();assert.ok(below.immersion>.98);assert.deepEqual(below.sun,top.sun);
 note('button submerges entire lens and leaves world sun unchanged',below);
 await page.screenshot({path:dest+'03-below.png'});
 note('below live performance',await performanceSample());
 const beforeDrift=await page.locator('.hero-visual--wet .hero__content').evaluate(el=>getComputedStyle(el).transform);
 await page.waitForTimeout(650);
 const afterDrift=await page.locator('.hero-visual--wet .hero__content').evaluate(el=>getComputedStyle(el).transform);
 assert.notEqual(beforeDrift,afterDrift);note('underwater component transform follows live wave probe');
 await page.getByRole('button',{name:'Pause ocean motion',exact:true}).click();await page.waitForTimeout(180);
 const paused=await snapshot();await page.waitForTimeout(550);assert.equal((await snapshot()).time,paused.time);
 note('pause freezes physical time');
 await page.getByRole('button',{name:'Play ocean motion',exact:true}).press('Space');await page.waitForTimeout(550);assert.ok((await snapshot()).time>paused.time);
 note('keyboard resumes ocean');
 await page.getByRole('button',{name:'Ocean — return to the surface',exact:true}).click();
 await page.waitForFunction(()=>window.__ocean.state.progress<.005);await page.waitForTimeout(500);
 note('return restores above-water framing',await snapshot());
 assert.deepEqual(errors,[]);assert.deepEqual((await snapshot()).errors,[]);
 const video=page.video();await context.close();if(video)await video.saveAs(dest+'ocean-interaction.webm');
 const mobile=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await mobile.goto(base);await mobile.waitForFunction(()=>window.__ocean?.state.ready);await mobile.waitForTimeout(500);
 assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mobile.screenshot({path:dest+'04-mobile-above.png'});
 await mobile.getByRole('button',{name:'Explore now',exact:true}).click();await mobile.waitForFunction(()=>window.__ocean.state.progress>.99);
 await mobile.screenshot({path:dest+'05-mobile-below.png'});
 assert.ok(await mobile.evaluate(()=>window.__ocean.state.immersion>.98));
 note('390×844 mobile emulation: no horizontal overflow, dive works');await mobile.close();
 const reduced=await browser.newPage({viewport:{width:1280,height:720},reducedMotion:'reduce'});
 await reduced.goto(base);await reduced.waitForFunction(()=>window.__ocean?.state.ready);
 const reducedTime=await reduced.evaluate(()=>window.__ocean.state.time);await reduced.waitForTimeout(350);
 assert.equal(await reduced.evaluate(()=>window.__ocean.state.time),reducedTime);
 await reduced.getByRole('button',{name:'Play ocean motion',exact:true}).click();await reduced.waitForTimeout(350);
 assert.ok(await reduced.evaluate(()=>window.__ocean.state.time)>reducedTime);
 note('reduced-motion defaults to stillness; explicit Play resumes');await reduced.close();
 await writeFile(dest+'verification.json',JSON.stringify({date:new Date().toISOString(),url:base,browser:'Google Chrome headless, ANGLE Metal',checks,errors,limitations:['Mobile is viewport emulation, not a physical iPhone.','FPS includes this machine and test capture overhead only.']},null,2));
 console.log('PASS',checks.length,'checks');
}finally{await browser.close();}

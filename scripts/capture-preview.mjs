import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const dest=fileURLToPath(new URL(`../分析/reference-20260921/${process.env.OCEAN_CAPTURE_DIR??'optimization-v9'}/`,import.meta.url));
await mkdir(dest,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1672,height:941},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto('http://localhost:4188/');
await page.waitForFunction(()=>window.__ocean?.state.ready,{timeout:60000});
await page.evaluate(()=>window.__ocean.setPaused(true));
const states=[];
for(const [name,p]of [['above',0],['half',.5],['below',1]]){
 await page.evaluate(p=>window.__ocean.renderAt(p,12),p);
 await page.waitForTimeout(100);
 await page.screenshot({path:dest+name+'.png'});
 states.push(await page.evaluate(()=>({...window.__ocean.state})));
}
await writeFile(dest+'preview-state.json',JSON.stringify({errors,states},null,2));
console.log(JSON.stringify({errors,states:states.map(({progress,immersion,resolution,fps})=>({progress,immersion,resolution,fps}))}));
await browser.close();

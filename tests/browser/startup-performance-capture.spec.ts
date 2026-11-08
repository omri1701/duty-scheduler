import {test,expect} from './fixtures';
import {mkdirSync,writeFileSync} from 'node:fs';
test('production readiness samples',async({context,openApp,baseURL},info)=>{
 const samples=[];
 for(let i=0;i<7;i++){
  const target=await context.newPage();
  await target.addInitScript(()=>{
   const start=performance.now(),result={shell:0,ready:0};Object.assign(window,{startupTiming:result});
   new MutationObserver(()=>{if(!result.shell&&document.querySelector('.startup-skeleton'))result.shell=performance.now()-start;if(!result.ready&&document.querySelector('.admin-avatar'))result.ready=performance.now()-start}).observe(document,{childList:true,subtree:true});
  });
  await openApp('admin',target);await expect(target.locator('.admin-avatar')).toBeVisible();
  samples.push(await target.evaluate(()=>(window as unknown as {startupTiming:object}).startupTiming));
  await target.close();
 }
 const phase=new URL(baseURL!).port==='8791'?'before':'after';
 mkdirSync('outputs/startup-layout',{recursive:true});
 writeFileSync(`outputs/startup-layout/${phase}-${info.project.name}-timings.json`,JSON.stringify(samples,null,2));
 console.log(phase,info.project.name,JSON.stringify(samples));
});

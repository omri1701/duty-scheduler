import {test,expect,seed} from './fixtures';
import {assertToolbar,assertMonthMenu} from './toolbar-assertions';
import {zoomContext,setBrowserZoom} from './zoom-context.mjs';

test('actual browser zoom adapts the served toolbar and menu in every manager state',async({backend,openApp},info)=>{
 test.skip(info.project.name!=='desktop','One isolated browser zoom matrix.');
 test.setTimeout(120_000);
 const context=await zoomContext();
 try {
  const page=await context.newPage();
  for(const state of ['new','published','reopened']) {
   backend.raw=seed();
   if(state==='published')backend.raw.months[0].status='published';
   if(state==='new'){backend.raw.months[0].current_publication_id=null;backend.raw.months[0].generated=false;backend.raw.publications=[];backend.raw.assignments=[];}
   await openApp('admin',page);
   for(const width of [1024,1280,1440]) {
    await page.setViewportSize({width,height:1000});
    for(const zoom of [1,1.25,1.5,2]) {
     expect(await setBrowserZoom(context,page,zoom)).toBe(zoom);
     for(const lang of ['en','he']) {
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      const toolbar=await assertToolbar(page);
      if(toolbar.containerWidth<960)await assertMonthMenu(page);
      if(width===1280&&state==='reopened')await info.attach(`${lang}-${zoom}`,{body:await page.screenshot({scale:'css'}),contentType:'image/png'});
      if(lang==='he')await page.getByRole('button',{name:'Switch to English',exact:true}).click();
     }
    }
   }
  }
 } finally {await context.close();}
});

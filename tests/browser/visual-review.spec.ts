import {test,expect} from '@playwright/test';
import {reviewHTML} from '../../scripts/visual-review-html.mjs';

test('review gallery filters screenshots and overlays unequal image sizes without scaling or cropping',async({page},info)=>{
  test.skip(info.project.name!=='desktop','Review UI once; includes both project groups.');
  await page.goto('about:blank');
  const images=await page.evaluate(()=>[ [20,30],[30,40] ].map(([width,height])=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    canvas.getContext('2d')!.fillRect(0,0,width,height);return canvas.toDataURL('image/png');
  }));
  const item={reference:'tests/browser/snapshots/linux/mobile/calendar-he.png',project:'mobile',platform:'linux',
    viewport:{width:390,height:844},viewportSource:'capture',language:'he',components:['Navigation'],
    scenario:'Calendar',retry:0,status:'failed',beforeHash:'before',afterHash:'after',imageSize:{width:30,height:40},
    before:images[0],after:images[1],difference:images[1]};
  await page.setContent(reviewHTML({references:[item.reference],items:[item,{...item,project:'desktop',language:'en',viewport:{width:1440,height:1000}}],
    errors:[],status:'failed',headCommit:'a'.repeat(40),sourceCommit:'b'.repeat(40),reviewId:'review'}));
  await expect(page.locator('#screenshot option')).toHaveCount(2);
  await page.locator('#project').selectOption('mobile');await page.locator('#language').selectOption('he');
  await expect(page.locator('#screenshot option')).toHaveCount(1);await expect(page.locator('#context')).toContainText('Navigation');
  await expect(page.locator('.overlay')).toHaveCSS('opacity','0.5');
  const overlay=(await page.locator('.overlay').boundingBox())!,base=(await page.locator('#comparison figure').last().locator('a img').boundingBox())!;
  expect(overlay.width).toBe(30);expect(overlay.height).toBe(40);expect(base.width).toBe(20);expect(base.height).toBe(30);
  expect(overlay.x).toBe(base.x);expect(overlay.y).toBe(base.y);
  await expect.poll(async()=> (await page.locator('#comparison figure').last().locator('.frame').boundingBox())!.height).toBe(42);
  await page.locator('#opacity').evaluate(node=>{(node as HTMLInputElement).value='75';node.dispatchEvent(new Event('input'))});
  await expect(page.locator('.overlay')).toHaveCSS('opacity','0.75');
  await page.locator('#viewport').selectOption('1440×1000');await expect(page.locator('#comparison figure')).toHaveCount(0);
});

test('review gallery treats screenshot/test names as inert data and explains missing references',async({page},info)=>{
  test.skip(info.project.name!=='desktop','Review UI once.');
  const payload='</script><img src=x onerror="window.reviewInjected=true">';
  await page.setContent(reviewHTML({references:[payload],items:[{reference:payload,project:'mobile',platform:'linux',
    viewport:null,viewportSource:'unspecified',language:'he',components:[payload],scenario:payload,retry:0,status:'failed',
    beforeHash:null,afterHash:'hash',imageSize:{width:1,height:1},before:null,after:null,difference:null}],errors:[],
    status:'failed',headCommit:'a'.repeat(40),sourceCommit:'b'.repeat(40),reviewId:'review'}));
  await expect(page.locator('#context')).toContainText(payload);await expect(page.locator('#references')).toHaveText(payload);
  await expect(page.locator('.missing')).toHaveCount(4);await expect(page.locator('body>img')).toHaveCount(0);
  expect(await page.evaluate(()=>Reflect.get(window,'reviewInjected'))).toBeUndefined();
});

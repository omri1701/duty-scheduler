import {test} from './fixtures';
import {webkit, devices} from '@playwright/test';
import {assertToolbar} from './toolbar-assertions';

for (const width of [1024,1280,1440,375,390,430]) {
  test(`served toolbar CSS and geometry at ${width}px`, async ({page,openApp},info) => {
    test.skip(info.project.name !== 'desktop', 'Run the matrix once.');
    const browser = width < 1024 ? await webkit.launch() : null;
    try {
      if (browser) page = await (await browser.newContext({...devices['iPhone 13'],viewport:{width,height:900},reducedMotion:'reduce',timezoneId:'Asia/Jerusalem'})).newPage();
      else await page.setViewportSize({width,height:1000});
      await openApp('admin',page);
      for (const language of ['en','he']) {
        if (language === 'he') await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
        const evidence = await assertToolbar(page);
        await info.attach(`computed-${language}`,{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
      }
    } finally {await browser?.close();}
  });
}

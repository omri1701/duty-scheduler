/* global chrome */
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const extension=fileURLToPath(new URL('./zoom-extension',import.meta.url));

export async function zoomContext() {
  // An isolated automation profile; uses actual browser tab zoom, not CSS zoom.
  return chromium.launchPersistentContext('',{channel:'chromium',headless:true,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    viewport:{width:1280,height:1000},locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
}
export async function setBrowserZoom(context,page,factor) {
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  return worker.evaluate(async({url,factor})=>{
    const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
    if(!tab?.id)throw Error('Application tab not found');
    await chrome.tabs.setZoomSettings(tab.id,{mode:'automatic',scope:'per-tab'});
    await chrome.tabs.setZoom(tab.id,factor);
    return chrome.tabs.getZoom(tab.id);
  },{url:page.url(),factor});
}

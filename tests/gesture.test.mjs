import test from 'node:test';
import assert from 'node:assert/strict';
import {attachHoldDrag} from '../lib/rota/gesture.ts';
function fixture(t,options={}){
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const root=new EventTarget(),doc=new EventTarget(),win=new EventTarget(),classes=new Set();root.classList={add:x=>classes.add(x),remove:x=>classes.delete(x)};root.contains=el=>!!el;
 doc.elementFromPoint=(x,y)=>x<0?null:{closest:()=>({dataset:{gestureKey:x<50?'2026-10-01':'2026-10-03'}})};
 const oldDoc=globalThis.document,oldWin=globalThis.window;globalThis.document=doc;globalThis.window=win;
 const calls=[],ignore={current:0};let enabled=true;
 const detach=attachHoldDrag(root,()=>({...options,enabled,onStart:k=>calls.push(['start',k]),onMove:k=>calls.push(['move',k]),onEnd:k=>calls.push(['end',k]),onCancel:()=>calls.push(['cancel'])}),ignore);
 t.after(()=>{detach();globalThis.document=oldDoc;globalThis.window=oldWin});
 function touch(type,x,y=0){const e=new Event(type,{cancelable:true});Object.defineProperties(e,{touches:{value:type==='touchend'?[]:[{clientX:x,clientY:y,identifier:1}]},changedTouches:{value:[{clientX:x,clientY:y,identifier:1}]}});root.dispatchEvent(e);return e;}
 function pointer(type,x){const e=new Event(type,{cancelable:true});Object.assign(e,{pointerType:'mouse',button:0,pointerId:1,clientX:x,clientY:0});(type==='pointerdown'?root:doc).dispatchEvent(e);return e;}
 return{calls,ignore,root,classes,touch,pointer,setEnabled:v=>enabled=v};
}
test('quick tap does not start a drag or suppress the normal click',t=>{const f=fixture(t);f.touch('touchstart',10);t.mock.timers.tick(100);f.touch('touchend',10);assert.deepEqual(f.calls,[]);assert.equal(f.ignore.current,0)});
test('scrolling before long press stays native and cancels the hold',t=>{const f=fixture(t);f.touch('touchstart',10);const e=f.touch('touchmove',10,25);t.mock.timers.tick(400);assert.equal(e.defaultPrevented,false);assert.deepEqual(f.calls,[])});
test('long press selects a start, sweeps a target and suppresses the follow-up tap',t=>{const f=fixture(t);f.touch('touchstart',10);t.mock.timers.tick(360);assert.ok(f.classes.has('gesture-active'));const move=f.touch('touchmove',75);assert.ok(move.defaultPrevented);f.touch('touchend',75);assert.deepEqual(f.calls,[['start','2026-10-01'],['move','2026-10-03'],['end','2026-10-03']]);assert.ok(f.ignore.current>Date.now());assert.equal(f.classes.has('gesture-active'),false)});
test('touch cancellation restores through cancellation callback and never commits',t=>{const f=fixture(t);f.touch('touchstart',10);t.mock.timers.tick(400);f.root.dispatchEvent(new Event('touchcancel'));assert.deepEqual(f.calls,[['start','2026-10-01'],['cancel']]);assert.equal(f.classes.has('gesture-active'),false)});
test('desktop drag starts after movement and commits the target',t=>{const f=fixture(t);f.pointer('pointerdown',10);f.pointer('pointermove',70);f.pointer('pointerup',70);assert.deepEqual(f.calls,[['start','2026-10-01'],['move','2026-10-03'],['end','2026-10-03']])});
test('disabled gestures do not modify state',t=>{const f=fixture(t);f.setEnabled(false);f.touch('touchstart',10);t.mock.timers.tick(500);f.touch('touchend',70);assert.deepEqual(f.calls,[])});
test('dropping outside cancels the destination without choosing the last hovered cell',t=>{const f=fixture(t);f.pointer('pointerdown',10);f.pointer('pointermove',70);f.pointer('pointerup',-1);assert.deepEqual(f.calls.at(-1),['end',null])});

test('availability can activate a shorter hold while quick scroll still cancels',t=>{const f=fixture(t,{holdMs:280});f.touch('touchstart',10);t.mock.timers.tick(279);assert.equal(f.calls.length,0);t.mock.timers.tick(1);assert.deepEqual(f.calls,[['start','2026-10-01']]);f.touch('touchend',10);assert.deepEqual(f.calls.at(-1),['end','2026-10-01']);});
test('moving within one cell does not repeatedly redraw the selection',t=>{const f=fixture(t);f.touch('touchstart',10);t.mock.timers.tick(360);f.touch('touchmove',70);f.touch('touchmove',72);f.touch('touchmove',75);f.touch('touchend',75);assert.equal(f.calls.filter(c=>c[0]==='move').length,1);});

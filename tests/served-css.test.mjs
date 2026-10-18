import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {currentCssHash,cssSourceHash,assertCssSource} from '../scripts/css-source.mjs';
import {verifyServedCss} from '../scripts/verify-served-css.mjs';

test('served CSS gate rejects old bytes at the same successful asset URL',async t=>{
 const hash=await currentCssHash();
 let css=`:root{--duty-css-source:${hash}}`,status=200,extra='';
 const server=createServer((req,res)=>{
  if(req.url==='/')res.end('<link rel="stylesheet" href="/_next/static/globals.css">'+extra);
  else if(req.url==='/stale.css')res.end('.month-toolbar{display:block}');
  else {res.writeHead(status,{'Content-Type':'text/css'});res.end(css);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal(await verifyServedCss(origin),hash);
 extra='<link rel="stylesheet" href="/stale.css">';
 await assert.rejects(verifyServedCss(origin),/does not match/);
 extra='';
 css=':root{--duty-css-source:'+cssSourceHash('previous revision')+'}';
 await assert.rejects(verifyServedCss(origin),/does not match/);
 status=404;
 await assert.rejects(verifyServedCss(origin),/CSS returned HTTP 404/);
 assert.throws(()=>assertCssSource('/* no stylesheet fingerprint */',hash),/does not match/);
 assert.throws(()=>assertCssSource(`:root{--duty-css-source:${hash}}:root{--duty-css-source:${cssSourceHash('old')}}`,hash),/does not match/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import cssSourcePlugin,{cssSourceHash,assertCssSource} from '../scripts/css-source.mjs';
const require=createRequire(import.meta.url);
const tailwind=require('@tailwindcss/postcss');
const postcss=createRequire(require.resolve('@tailwindcss/postcss'))('postcss');

test('custom CSS follows transform input even when the file changes before compiler mtime sampling',async t=>{
 await mkdir('work',{recursive:true});
 const directory=await mkdtemp(resolve('work/css-transform-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=await readFile('app/globals.css','utf8');
 const first=source+'\n.duty-cache-probe{color:#123456}',second=source+'\n.duty-cache-probe{color:#abcdef}';
 const file=resolve(directory,'globals.css');
 // Next can have read old input before Tailwind sees the newly saved mtime.
 await writeFile(file,second);
 const processor=postcss([cssSourcePlugin(),tailwind({base:process.cwd(),optimize:false})]);
 assert((await processor.process(first,{from:file})).css.includes('#123456'));
 const result=await processor.process(second,{from:file});
 assert(result.css.includes('#abcdef'),'Warm transform must not reuse an older custom stylesheet');
 assert(!result.css.includes('#123456'));
 assert(result.css.includes(cssSourceHash(second)));
});

test('fingerprint precedes the Tailwind cache, so stale output cannot claim current input',async t=>{
 const directory=await mkdtemp(resolve('work/css-transform-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const first='@import "tailwindcss" source(none); .cache-probe{color:#123456}',second=first.replace('#123456','#abcdef');
 const file=resolve(directory,'globals.css');await writeFile(file,second);
 const processor=postcss([cssSourcePlugin(),tailwind({base:process.cwd(),optimize:false})]);
 await processor.process(first,{from:file});
 const result=await processor.process(second,{from:file});
 // This pinned compiler may reuse the old AST; the gate must always tell the truth.
 if(result.css.includes('#123456'))assert.throws(()=>assertCssSource(result.css,cssSourceHash(second)),/does not match/);
 else assertCssSource(result.css,cssSourceHash(second));
});

test('minified fingerprint survives hashes that look like scientific notation',async t=>{
 const directory=await mkdtemp(resolve('work/css-transform-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 // CI's LF globals.css hashed to 8335e2…, which the minifier rewrote as 833500….
 let source;
 for(let i=0;!source||!/^\d+e\d/.test(cssSourceHash(source));i++)source=`.probe-${i}{color:red}`;
 const file=resolve(directory,'globals.css');await writeFile(file,source);
 const result=await postcss([cssSourcePlugin(),tailwind({base:process.cwd(),optimize:{minify:true}})]).process(source,{from:file});
 assertCssSource(result.css,cssSourceHash(source));
});

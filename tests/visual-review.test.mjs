import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {Script} from 'node:vm';
import Reporter,{ciSummary,mergeShardGalleries} from '../scripts/visual-review-reporter.mjs';
import {reviewHTML} from '../scripts/visual-review-html.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=','base64');
function fixture(t){
  const parent=resolve('work');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'visual-review-test-'));
  t.after(()=>{assert(root.startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
  const snapshots=join(root,'tests/browser/snapshots/linux/mobile'),outputDir=join(root,'test-results/case');
  mkdirSync(snapshots,{recursive:true});mkdirSync(outputDir,{recursive:true});
  const reference=join(snapshots,'calendar-he.png'),actual=join(outputDir,'calendar-he-actual.png'),diff=join(outputDir,'calendar-he-diff.png');
  writeFileSync(reference,image);writeFileSync(actual,Buffer.concat([image,Buffer.from('candidate')]));writeFileSync(diff,image);
  const project={name:'mobile',outputDir,use:{viewport:{width:390,height:844},locale:'en-GB'}};
  const scenario={id:'calendar',expectedStatus:'passed',parent:{project:()=>project},titlePath:()=>['','mobile','calendar RTL']};
  const result={retry:0,status:'failed',annotations:[],attachments:[
    {name:'calendar-he-expected.png',path:reference},{name:'calendar-he-actual.png',path:actual},{name:'calendar-he-diff.png',path:diff}]};
  const reporter=new Reporter({root,sourceCommit:'a'.repeat(40),headCommit:'b'.repeat(40)});reporter.onBegin();
  const manifest=()=>JSON.parse(readFileSync(join(root,'work/visual-review/manifest.json'),'utf8'));
  return {root,reference,actual,project,scenario,result,reporter,manifest};
}

test('collects every soft screenshot failure with exact reference/candidate hashes without baseline writes',t=>{
  const f=fixture(t),before=readFileSync(f.reference);f.reporter.onTestEnd(f.scenario,f.result);
  const team=join(dirname(f.reference),'team-en.png');writeFileSync(team,image);
  const other={...f.result,attachments:f.result.attachments.map(a=>({...a,name:a.name.replace('calendar-he','team-en'),path:a.name.includes('-expected')?team:a.path}))};
  f.reporter.onTestEnd({...f.scenario,id:'team'},other);assert.equal(f.reporter.onEnd({status:'failed'}),undefined);
  const m=f.manifest();assert.equal(m.items.length,2);assert.equal(m.references.length,2);
  assert.equal(m.items[0].reference,'tests/browser/snapshots/linux/mobile/calendar-he.png');
  assert.equal(m.items[0].beforeHash,hash(before));assert.equal(m.items[0].afterHash,hash(readFileSync(f.actual)));
  assert.equal(m.items[0].language,'he');assert.deepEqual(m.items[0].viewport,{width:390,height:844});
  assert.equal(m.headCommit,'b'.repeat(40));assert.equal(m.sourceCommit,'a'.repeat(40));assert(m.approvalRequired);
  assert.deepEqual(readFileSync(f.reference),before);assert(existsSync(join(f.root,'work/visual-review',m.items[0].difference)));
});

test('missing references are review candidates, never implicitly created',t=>{
  const f=fixture(t);f.result.attachments=f.result.attachments.filter(a=>!a.name.includes('-expected'));
  rmSync(f.reference);
  f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});
  const m=f.manifest();assert.equal(m.items[0].kind,'missing reference');assert.equal(m.items[0].before,null);
  assert.equal(m.references[0],`tests/browser/snapshots/${process.platform}/mobile/calendar-he.png`);
  assert(!existsSync(join(f.root,m.references[0])));
});

test('retains earlier screenshot differences when a retry passes, with final test status',t=>{
  const f=fixture(t);f.reporter.onTestEnd(f.scenario,f.result);
  f.reporter.onTestEnd(f.scenario,{...f.result,retry:1,status:'passed',attachments:[]});
  f.reporter.onEnd({status:'passed'});const m=f.manifest();assert(m.approvalRequired);
  assert.equal(m.status,'passed');assert.equal(m.items[0].finalStatus,'passed');assert.equal(m.items[0].status,'failed');
});

test('capture annotations override configured viewport/language and malformed metadata fails closed',t=>{
  const f=fixture(t);f.result.annotations=[{type:'visual-review',description:JSON.stringify({name:'calendar-he.png',viewport:{width:320,height:900},language:'he',components:['Navigation']})}];
  f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});
  assert.deepEqual(f.manifest().items[0].viewport,{width:320,height:900});assert.deepEqual(f.manifest().items[0].components,['Navigation']);
  f.result.annotations[0].description='{bad';f.reporter.onTestEnd(f.scenario,f.result);
  assert.deepEqual(f.reporter.onEnd({status:'passed'}),{status:'failed'});assert(f.manifest().errors.length);
});

test('rejects attachment traversal, disguised non-images and missing-reference traversal',t=>{
  const f=fixture(t),outside=join(f.root,'private.png');writeFileSync(outside,image);
  f.result.attachments[1].path=outside;f.reporter.onTestEnd(f.scenario,f.result);
  assert.deepEqual(f.reporter.onEnd({status:'passed'}),{status:'failed'});assert.equal(f.manifest().items.length,0);
  f.result.attachments[1].path=f.actual;writeFileSync(f.actual,'synthetic private text');f.reporter.onTestEnd(f.scenario,f.result);
  assert.deepEqual(f.reporter.onEnd({status:'passed'}),{status:'failed'});
  f.result.attachments=f.result.attachments.filter(a=>!a.name.includes('-expected'));f.project.name='../../outside';
  writeFileSync(f.actual,image);f.reporter.onTestEnd(f.scenario,f.result);assert(f.reporter.errors.length>=3);
});

test('review ID changes for changed candidates but remains valid across nonvisual source commits',t=>{
  const f=fixture(t);f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});const first=f.manifest().reviewId;
  f.reporter.sourceCommit='c'.repeat(40);f.reporter.onEnd({status:'failed'});assert.equal(f.manifest().reviewId,first);
  f.reporter.items[0].afterHash='d'.repeat(64);f.reporter.onEnd({status:'failed'});assert.notEqual(f.manifest().reviewId,first);
});

test('initialization errors fail the run rather than becoming an apparently clean gallery',t=>{
  const f=fixture(t),reporter=new Reporter({root:f.root,sourceCommit:'invalid'});
  reporter.onBegin();assert.deepEqual(reporter.onEnd({status:'passed'}),{status:'failed'});
  assert(f.manifest().errors.some(message=>message.includes('exact source/head commit')));
});

test('a clean focused run records no differences while retaining earlier review evidence',t=>{
  const f=fixture(t);f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});
  const evidence=join(f.root,'work/visual-review',f.manifest().items[0].after);
  const next=new Reporter({root:f.root,sourceCommit:'a'.repeat(40)});next.onBegin();next.onEnd({status:'passed'});
  assert.deepEqual(f.manifest().references,[]);assert(!f.manifest().approvalRequired);
  assert(existsSync(evidence));assert.equal(f.manifest().history[0].count,1);
});

test('gallery safely encodes test strings and provides original-size before/after/diff/overlay filters',()=>{
  const html=reviewHTML({items:[{scenario:'</script><img src=x onerror=alert(1)>'}],references:[],errors:[]});
  assert(!html.includes('</script><img'));assert(html.includes('\\u003c/script>'));
  for(const label of ['BEFORE','AFTER','DIFFERENCE','OVERLAY','project','viewport','language','platform','afterHash'])assert(html.includes(label));
  assert(html.includes('width:auto;max-width:none'));assert(html.includes('Math.max(img.naturalWidth,after.naturalWidth)'));
  assert.doesNotThrow(()=>new Script(html.split('<script>')[1].split('</script>')[0]));
});

test('CI summary links only an allowed GitHub artifact and never modifies baseline hashes',t=>{
  const f=fixture(t);f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});
  const summary=join(f.root,'summary.md'),url='https://github.com/example/duty/actions/runs/123/artifacts/456';
  assert(ciSummary(f.root,{GITHUB_STEP_SUMMARY:summary,VISUAL_REVIEW_URL:url}).includes(url));
  assert(!ciSummary(f.root,{GITHUB_STEP_SUMMARY:summary,VISUAL_REVIEW_URL:'javascript:alert(1)'}).includes('javascript:'));
  assert.equal(hash(readFileSync(f.reference)),hash(image));
});

test('Quality keeps strict screenshot gating and read-only CI permissions while uploading failed reviews',()=>{
  const workflow=readFileSync('.github/workflows/quality.yml','utf8'),config=readFileSync('playwright.config.ts','utf8');
  assert.match(workflow,/permissions:\s+contents: read/);assert(!workflow.includes('pull_request_target:'));
  assert(!workflow.includes('pull-requests: write'));assert(!workflow.includes('continue-on-error:'));
  assert.match(workflow,/name: Retain screenshot comparison gallery[\s\S]*?if: \$\{\{ !cancelled\(\) \}\}[\s\S]*?path: work\/visual-review\//);
  assert.match(workflow,/VISUAL_REVIEW_HEAD_SHA: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(config,/updateSnapshots: 'none'/);assert.match(config,/maxDiffPixels: 0/);assert.match(config,/visual-review-reporter.mjs/);
});

test('sharded galleries merge into one review, report missing shards and reject forged paths',t=>{
  const f=fixture(t),shards=join(f.root,'work/visual-review-shards'),output=join(f.root,'work/visual-review'),before=readFileSync(f.reference);
  f.reporter.onTestEnd(f.scenario,f.result);f.reporter.onEnd({status:'failed'});
  mkdirSync(shards,{recursive:true});renameSync(output,join(shards,'visual-review-shard-1'));
  const other=new Reporter({root:f.root,sourceCommit:'a'.repeat(40),headCommit:'b'.repeat(40)});other.onBegin();other.onEnd({status:'passed'});
  renameSync(output,join(shards,'visual-review-shard-2'));mkdirSync(join(shards,'visual-review-shard-3'));
  const m=mergeShardGalleries(f.root);
  assert.equal(m.shards,2);assert.equal(m.items.length,1);assert.equal(m.status,'failed');assert(m.approvalRequired);
  assert.deepEqual(m.references,['tests/browser/snapshots/linux/mobile/calendar-he.png']);
  assert(m.errors.some(error=>error.includes('visual-review-shard-3')));
  assert(existsSync(join(output,m.items[0].after)));assert(existsSync(join(output,'index.html')));
  assert.deepEqual(JSON.parse(readFileSync(join(output,'manifest.json'),'utf8')),m);assert.deepEqual(readFileSync(f.reference),before);
  const path=join(shards,'visual-review-shard-1/manifest.json'),original=readFileSync(path,'utf8');
  const forge=change=>{const manifest=JSON.parse(original);change(manifest);writeFileSync(path,JSON.stringify(manifest));rmSync(output,{recursive:true,force:true});};
  forge(manifest=>{manifest.items[0].after='../../../../tests/browser/snapshots/linux/mobile/calendar-he.png';});
  assert.throws(()=>mergeShardGalleries(f.root),/Invalid shard review image path/);
  forge(manifest=>{manifest.headCommit='c'.repeat(40);});
  assert.throws(()=>mergeShardGalleries(f.root),/disagree/);
});

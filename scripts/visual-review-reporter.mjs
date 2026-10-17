// Read-only screenshot review. Never creates or updates approved references.
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync,appendFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {reviewHTML} from './visual-review-html.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
const hash=data=>createHash('sha256').update(data).digest('hex');
function inside(root,path){
  const rel=relative(realpathSync(root),realpathSync(path));
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('Visual review path escapes its allowed directory');
  return path;
}
function png(path,allowed){
  inside(allowed,path);const data=readFileSync(path);
  if(!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.length<24)throw Error('Visual review requires a PNG attachment');
  return data;
}

export default class VisualReviewReporter {
  constructor(options={}){this.root=realpathSync(options.root??repository);this.items=[];this.errors=[];this.finalStatuses=new Map();this.options=options;}
  onBegin(){
    try{this.prepare();}catch(error){this.errors.push(error.message);}
  }
  prepare(){
    // Keep immutable run evidence: later focused checks must not discard review images.
    const work=join(this.root,'work');mkdirSync(work,{recursive:true});inside(this.root,work);
    this.output=join(work,'visual-review');
    if(existsSync(this.output)){
      if(lstatSync(this.output).isSymbolicLink())throw Error('Visual review output must not be a symlink');
      inside(work,this.output);
    }
    const runs=join(this.output,'runs');mkdirSync(runs,{recursive:true});inside(work,runs);
    this.runID=Date.now().toString(36)+'-'+randomBytes(6).toString('hex');this.capture=join(runs,this.runID);
    mkdirSync(join(this.capture,'images'),{recursive:true});
    const git=spawnSync('git',['rev-parse','HEAD'],{cwd:this.root,encoding:'utf8'}).stdout?.trim();
    this.sourceCommit=this.options.sourceCommit??process.env.VISUAL_REVIEW_SOURCE_SHA??git;
    this.headCommit=this.options.headCommit??process.env.VISUAL_REVIEW_HEAD_SHA??this.sourceCommit;
    for(const sha of [this.sourceCommit,this.headCommit])if(!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Visual review needs an exact source/head commit');
    const status=spawnSync('git',['status','--porcelain'],{cwd:this.root,encoding:'utf8'});
    this.workingTree=process.env.VISUAL_REVIEW_TREE_STATE??(status.status===0?(status.stdout.trim()?'dirty':'clean'):'unavailable');
  }
  onTestEnd(test,result){
    this.finalStatuses.set(test.id,result.status);
    try {
      const project=test.parent.project(),snapshots=join(this.root,'tests','browser','snapshots');
      inside(this.root,snapshots);
      for(const actual of result.attachments.filter(a=>a.name.endsWith('-actual.png')&&a.path)){
        const name=actual.name.replace(/-actual\.png$/,'.png');
        const expected=result.attachments.find(a=>a.name===name.replace(/\.png$/,'-expected.png'));
        const diff=result.attachments.find(a=>a.name===name.replace(/\.png$/,'-diff.png'));
        const reference=expected?.path??join(snapshots,process.platform,project.name,name);
        // No guessing outside the repository's snapshot/output roots, including symlinks.
        inside(this.root,project.outputDir);
        if(expected?.path)inside(snapshots,reference);
        else if(relative(snapshots,resolve(reference)).split(sep).includes('..'))throw Error('Invalid missing screenshot reference');
        const referencePath=relative(this.root,reference).split(sep).join('/');
        const after=png(actual.path,project.outputDir),before=expected?.path?png(expected.path,snapshots):null;
        const id=hash(`${test.id}\0${referencePath}\0${result.retry}`).slice(0,24);
        const files={};
        for(const [kind,data] of [['before',before],['after',after],['difference',diff?.path?png(diff.path,project.outputDir):null]]){
          files[kind]=data?`images/${id}-${kind}.png`:null;
          if(data)writeFileSync(join(this.capture,files[kind]),data);
        }
        const annotation=result.annotations?.find(a=>a.type==='visual-review'&&JSON.parse(a.description).name===name);
        const metadata=annotation?JSON.parse(annotation.description):{};
        if(metadata.viewport&&(!Number.isFinite(metadata.viewport.width)||!Number.isFinite(metadata.viewport.height)))throw Error('Invalid visual viewport metadata');
        if(metadata.components&&(!Array.isArray(metadata.components)||!metadata.components.every(value=>typeof value==='string')))throw Error('Invalid visual component metadata');
        this.items.push({testId:test.id,reference:referencePath,project:project.name,platform:referencePath.split('/')[3],
          viewport:metadata.viewport??project.use.viewport??null,viewportSource:metadata.viewport?'capture':'project configuration',
          language:metadata.language??(/-he(?:-|\.)/.test(name)?'he':project.use.locale??'unspecified'),
          components:metadata.components??[],scenario:test.titlePath().filter(Boolean).join(' › '),
          retry:result.retry,status:result.status,expectedStatus:test.expectedStatus,
          kind:before?(hash(before)===hash(after)?'unstable capture':'changed'):'missing reference',beforeHash:before?hash(before):null,afterHash:hash(after),
          imageSize:{width:after.readUInt32BE(16),height:after.readUInt32BE(20)},...files});
      }
    }catch(error){this.errors.push(error.message);}
  }
  onEnd(result){
    try {
      const references=[...new Set(this.items.map(item=>item.reference))].sort();
      // Retain retry differences even if a later attempt passes: flakes need inspection.
      const reviewedImages=this.items.map(({reference,beforeHash,afterHash})=>({reference,beforeHash,afterHash}));
      reviewedImages.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const manifest={version:1,reviewId:hash(JSON.stringify(reviewedImages)),sourceCommit:this.sourceCommit,headCommit:this.headCommit,workingTree:this.workingTree,
        status:result.status,approvalRequired:references.length>0,references,
        items:this.items.map(item=>({...item,finalStatus:this.finalStatuses.get(item.testId)})),errors:this.errors};
      writeFileSync(join(this.capture,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
      writeFileSync(join(this.capture,'index.html'),reviewHTML(manifest));
      const history=readdirSync(join(this.output,'runs')).filter(id=>id!==this.runID&&/^[a-z0-9]+-[a-f0-9]{12}$/.test(id)).sort().reverse().flatMap(id=>{
        const path=join(this.output,'runs',id,'manifest.json');if(!existsSync(path))return [];
        inside(this.output,path);
        const old=JSON.parse(readFileSync(path,'utf8'));return [{url:`runs/${id}/index.html`,count:old.references.length,sourceCommit:old.sourceCommit}];
      });
      const latest={...manifest,history,items:manifest.items.map(item=>({...item,...Object.fromEntries(['before','after','difference'].map(key=>[key,item[key]?`runs/${this.runID}/${item[key]}`:null]))}))};
      writeFileSync(join(this.output,'manifest.json'),JSON.stringify(latest,null,2)+'\n');
      writeFileSync(join(this.output,'index.html'),reviewHTML(latest));
      console.log(`Visual review: ${references.length} changed/missing references. ${join(this.output,'index.html')}`);
      if(this.errors.length){console.error('Visual review preparation failed:',this.errors.join('; '));return {status:'failed'};}
    }catch(error){console.error('Visual review preparation failed:',error.message);return {status:'failed'};}
  }
}

// Only publishes a summary/link. No API writes, baseline writes or privileged token.
export function ciSummary(root=repository,env=process.env){
  const path=join(root,'work','visual-review','manifest.json');
  let summary='### Visual review\n\n';
  if(!existsSync(path))summary+='Unavailable: browser checks did not produce a gallery. Do not infer visual approval.\n';
  else {
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    if(!Array.isArray(manifest.references)||!Array.isArray(manifest.errors))throw Error('Invalid review manifest');
    const count=manifest.references.length;
    summary+=`${count} changed/missing screenshot references. ${count?'Explicit user approval is required before any reference update.':'No screenshot reference approval needed for this run.'}\n\n`;
    const url=env.VISUAL_REVIEW_URL;
    if(url&&/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/.test(url))summary+=`[Download visual-review gallery](${url}) — extract and open index.html. Exact reference paths and candidate hashes are in manifest.json.\n`;
    if(manifest.errors.length)summary+='\nGallery preparation reported errors; inspect the manifest before review.\n';
  }
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,summary);
  else console.log(summary);
  return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv[2]!=='--ci-summary')throw Error('Only --ci-summary is supported; references are never updated by this tool');
  ciSummary();
}

// Ordinary-baseline validation: the count-vector allocation_fit must decide exactly
// like the original per-duty search and an independent exhaustive oracle, and
// realistic lumpy months must validate well within the hosted statement limit.
// Pure IMMUTABLE functions only; no fixtures, nothing is written.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {canonicalDuties} from '../../lib/scheduling/calendar.ts';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const psql=(query,stop=true)=>{const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres',...(stop?['-v','ON_ERROR_STOP=1']:[])],{input:query,encoding:'utf8',maxBuffer:64*1024*1024});
 if(stop)assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').filter(x=>x.startsWith('{')).map(JSON.parse)};
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
let seed=20261030;const random=()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
const pick=a=>a[Math.floor(random()*a.length)];
const gcd=(a,b)=>b?gcd(b,a%b):a;

// Independent oracle: full dynamic program over every sub-vector of duty counts,
// without the range, ordering or bound pruning used in SQL.
function oracle(weights,n){
 const vals=[...new Set(weights)].sort((a,b)=>b-a),counts=vals.map(v=>weights.filter(w=>w===v).length);
 const radix=[1];for(const c of counts)radix.push(radix.at(-1)*(c+1));
 const digit=(r,j)=>Math.floor(r/radix[j])%(counts[j]+1),load=r=>vals.reduce((s,v,j)=>s+v*digit(r,j),0),cache=new Map();
 const subs=r=>{if(!cache.has(r)){let out=[0];for(let j=0;j<vals.length;j++){const next=[];for(const t of out)for(let x=0;x<=digit(r,j);x++)next.push(t+x*radix[j]);out=next}cache.set(r,out)}return cache.get(r)};
 const full=radix.at(-1)-1,layers=[new Map([[0,0]])];
 for(let m=1;m<=n;m++){const f=new Map();for(let r=0;r<=full;r++){let best=Infinity;for(const t of subs(r)){const rest=layers[m-1].get(r-t);if(rest!==undefined)best=Math.min(best,load(t)**2+rest)}if(best<Infinity)f.set(r,best)}layers.push(f)}
 const shares=[];for(let m=n,r=full;m>0;m--){const t=subs(r).find(t=>layers[m-1].has(r-t)&&load(t)**2+layers[m-1].get(r-t)===layers[m].get(r));shares.push(load(t));r-=t}
 const partition=caps=>{let states=new Set([full]);for(const cap of caps){const next=new Set();for(const r of states)for(const t of subs(r))if(load(t)===cap)next.add(r-t);states=next}return states.has(0)};
 const best=layers[n].get(full);
 return {shares,accept:caps=>caps.length===n&&partition(caps)&&caps.reduce((s,x)=>s+x*x,0)===best};
}
// Baselines a client might send: optimum, equal split, greedy, random partitions and near misses.
function candidates(weights,n,shares){
 const total=weights.reduce((a,b)=>a+b,0),q=weights.reduce(gcd,0),out=[shares];
 const share=Math.floor(total/(n*q))*q,left=(total-share*n)/q;out.push(Array.from({length:n},(_,i)=>share+(i<left?q:0)));
 const greedy=Array(n).fill(0);for(const w of [...weights].sort((a,b)=>b-a)){greedy.sort((a,b)=>a-b);greedy[0]+=w}out.push(greedy);
 for(let i=0;i<2;i++){const bins=Array(n).fill(0);for(const w of weights)bins[Math.floor(random()*n)]+=w;out.push(bins)}
 for(const base of [shares,greedy])if(n>1)for(const d of [1,q]){const v=[...base],a=Math.floor(random()*n),b=(a+1+Math.floor(random()*(n-1)))%n;v[a]+=d;v[b]-=d;if(v[b]>=0)out.push(v)}
 const over=[...shares];over[0]+=q;out.push(over);
 return out;
}
const old=`create or replace function pg_temp.old_fit(f jsonb,baseline jsonb) returns boolean language plpgsql as $$
declare weights integer[]; capacities integer[]; n integer; total integer; cost bigint; quantum integer:=0; w integer;
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 n:=cardinality(capacities);
 foreach w in array weights loop quantum:=gcd(quantum,w); end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(capacities) x;
 return duty_private.allocation_partition(weights,capacities) and not duty_private.allocation_better_baseline(weights,array_fill(0,array[n]),cost,quantum,total);
end$$;
create or replace function pg_temp.accept(f jsonb,b jsonb) returns boolean language plpgsql as $$begin perform duty_private.allocation_baseline(f,b);return true;
exception when raise_exception then if sqlerrm<>'invalid-ordinary-baseline' then raise;end if;return false;end$$;`;
const call=(weights,caps)=>[quote({duties:weights.map(units=>({units}))}),quote(Object.fromEntries(caps.map((units,i)=>[String(i),units])))];
const row=(i,weights,caps,withOld)=>{const [f,b]=call(weights,caps);
 return `select jsonb_build_object('i',${i},'fit',duty_private.allocation_fit('{${[...weights].sort((a,b)=>b-a)}}'::integer[],'{${[...caps].sort((a,b)=>b-a)}}'::integer[]),'accept',pg_temp.accept(${f},${b})${withOld?`,'old',pg_temp.old_fit(${f},${b})`:''});`};

// 1. Small exhaustive and random sets: new, wired and original SQL, and the oracle agree.
const small=[];
for(const weights of [[2,2,2],[1,4,5],[2,2,7,7],[1,2,3,4],[6,6,5,2,2],[5,5,5,2,1],[3,3,3,3,2]]){
 const total=weights.reduce((a,b)=>a+b,0),check=oracle(weights,3);
 for(let a=total;a>=0;a--)for(let b=Math.min(a,total-a);b>=0;b--){const c=total-a-b;if(c<=b)small.push({weights,caps:[a,b,c],expected:check.accept([a,b,c])})}
}
for(let s=0;s<160;s++){
 const n=1+Math.floor(random()*5),weights=Array.from({length:1+Math.floor(random()*8)},()=>pick([1,2,2,2,3,4,5,6,6,7,10,12])),check=oracle(weights,n);
 for(const caps of candidates(weights,n,check.shares))small.push({weights,caps,expected:check.accept(caps)});
}
const smallResults=psql(`set statement_timeout='60s';begin;${old}${small.map((c,i)=>row(i,c.weights,c.caps,true)).join('\n')}rollback;`);
assert.equal(smallResults.length,small.length);
for(const r of smallResults){const c=small[r.i];assert.deepEqual([r.fit,r.accept,r.old],[c.expected,c.expected,c.expected],JSON.stringify(c))}
console.log(`PASS: allocation_fit, allocation_baseline and the original search agree with the oracle on ${small.length} small baselines (${small.filter(c=>c.expected).length} accepted)`);

// 2. Realistic months: canonical weights with special ranges, extras and split weekends.
const realistic=[];
for(let s=0;s<70;s++){
 const month=`${2026+Math.floor(random()*3)}-${String(1+Math.floor(random()*12)).padStart(2,'0')}`,day=1+Math.floor(random()*14),length=7+Math.floor(random()*8);
 const start=`${month}-${String(day).padStart(2,'0')}`,end=new Date(Date.parse(start+'T12:00:00Z')+length*864e5).toISOString().slice(0,10);
 const specials=random()<0.85?[{id:'s',start,end,extra:pick([0.5,1,1.5,2,3])}]:[];
 const weights=canonicalDuties(month,{specials}).map(d=>d.units),n=pick([3,5,8,10,11,12,13]),check=oracle(weights,n);
 for(const caps of candidates(weights,n,check.shares))realistic.push({weights,caps,expected:check.accept(caps)});
}
const realResults=psql(`begin;${old}${realistic.map((c,i)=>row(i,c.weights,c.caps,false)).join('\n')}rollback;`);
assert.equal(realResults.length,realistic.length);
for(const r of realResults){const c=realistic[r.i];assert.deepEqual([r.fit,r.accept],[c.expected,c.expected],JSON.stringify(c))}
// The original search is exponential on lumpy months; compare it wherever it finishes.
// Every fourth case bounds CI time; its timeouts are skipped, not counted as agreement.
const compared=psql(`${old}set statement_timeout='200ms';${realistic.map((c,i)=>{const [f,b]=call(c.weights,c.caps);return i%4?'':`select jsonb_build_object('i',${i},'old',pg_temp.old_fit(${f},${b}));`}).join('\n')}`,false);
for(const r of compared)assert.equal(r.old,realistic[r.i].expected,JSON.stringify(realistic[r.i]));
assert(compared.length>=35&&compared.some(r=>r.old)&&compared.some(r=>!r.old),`Original search finished only ${compared.length} realistic cases`);
console.log(`PASS: ${realistic.length} realistic month baselines match the oracle (${realistic.filter(c=>c.expected).length} accepted); the original search agrees on the ${compared.length} of ${Math.ceil(realistic.length/4)} sampled that it finishes within 200 ms`);

// 3. Lumpy months that timed out the original search: +2 and +1 over a 14-day special, 12 engineers.
const repeat=(units,count)=>Array(count).fill(units);
const lumpy=[['November +2',[...repeat(6,10),...repeat(5,4),...repeat(2,14)]],['December +2',[...repeat(6,10),...repeat(5,4),...repeat(2,15)]],['November +1',[...repeat(4,10),...repeat(3,4),...repeat(2,14)]]];
const timed=[];
for(const [name,weights] of lumpy){const check=oracle(weights,12),[fit,equal]=candidates(weights,12,check.shares),inflated=[...fit];inflated[0]+=1;inflated[11]-=1;
 for(const [kind,caps] of [['fit',fit],['equal split',equal],['inflated',inflated]])timed.push({name:`${name} ${kind}`,weights,caps,expected:check.accept(caps)});}
assert.deepEqual(timed.map(c=>c.expected),[true,false,false,true,false,false,true,false,false]);
const times=psql(`set statement_timeout='1s';begin;${old}`+timed.map((c,i)=>{const [f,b]=call(c.weights,c.caps);return `select clock_timestamp() t0 \\gset\nselect jsonb_build_object('i',${i},'accept',pg_temp.accept(${f},${b}),'ms',extract(epoch from clock_timestamp()-:'t0'::timestamptz)*1000);`}).join('\n')+'rollback;');
for(const r of times){const c=timed[r.i];assert.equal(r.accept,c.expected,c.name);assert(r.ms<500,`${c.name} took ${r.ms} ms`);console.log(`  ${c.name}: ${r.accept?'accepted':'rejected'} in ${r.ms.toFixed(1)} ms`)}
console.log('PASS: lumpy 12-engineer special months validate in under 500 ms each');

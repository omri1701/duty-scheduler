import test from 'node:test';
import assert from 'node:assert/strict';
import {saveGeneration,confirmAllocation,generationContext,readGenerationContext} from '../lib/supabase/generation.ts';
import {registerEnvironment} from '../lib/supabase/write-policy.ts';

test('generation writes retain the captured revision and fingerprint, and never retry stale output',async()=>{
 const captured={revision:37,fingerprint:'captured',input:{schedule:{month:'2027-12'}}};
 const calls=[],error={code:'40001',message:'Refresh and review'};
 const client={rpc:async(...args)=>{calls.push(args);return {data:null,error}}};
 await assert.rejects(saveGeneration(client,captured,{'2027-12-01':{primary:'a'}},42),e=>e===error);
 await assert.rejects(confirmAllocation(client,captured,{}),e=>e===error);
 assert.deepEqual(calls[0],['duty_save_generation',{p_month:'2027-12',p_assignments:{'2027-12-01':{primary:'a'}},p_revision:37,p_fingerprint:'captured',p_seed:42}]);
 assert.equal(calls[1][1].p_revision,37);assert.equal(calls[1][1].p_fingerprint,'captured');assert.equal(calls.length,2);
});
test('hand-edit protection is local editing state and never reaches the checked RPC',async()=>{
 const calls=[],client={rpc:async(...args)=>{calls.push(args);return {data:null,error:{message:'stop'}}}};
 const draft={baselineUnits:{},offeredUnits:{},targetsUnits:{},repayments:[],transfers:[],pending:[],sourceKey:'k',handEdited:['a']};
 await assert.rejects(confirmAllocation(client,{revision:1,fingerprint:'f',input:{schedule:{month:'2027-12'}}},draft));
 assert.deepEqual(Object.keys(calls[0][1].p_allocation),['baselineUnits','offeredUnits','targetsUnits','repayments','transfers','pending','sourceKey']);
 assert.deepEqual(draft.handEdited,['a']);
});
test('generation context and writes honor the existing read-only inspection guard',async()=>{
 const client={rpc:async()=>assert.fail('read-only client performed RPC')};registerEnvironment(client,{readOnly:true});
 await assert.rejects(generationContext(client,'2027-12',37),/read.only|Production/i);
 await assert.rejects(saveGeneration(client,{}, {},1),/read.only|Production/i);
 await assert.rejects(confirmAllocation(client,{}, {}),/read.only|Production/i);
});
test('malformed authoritative contexts fail before reaching scheduling or storage',()=>{
 for(const value of [null,{}, {revision:1,facts:[]}, {revision:NaN,fingerprint:'x'}])assert.throws(()=>readGenerationContext(value),/Invalid generation context/);
});

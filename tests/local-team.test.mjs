import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCAL_TEMPORARY_MEMBERS,missingTemporaryMembers} from '../scripts/local-supabase.mjs';

test('local reset team adds ten named temporary members in seniority order and skips existing names',()=>{
 assert.deepEqual(LOCAL_TEMPORARY_MEMBERS,['Avi','Dana','Yossi','Noa','Eitan','Maya','Lior','Tamar','Omer','Shira']);
 assert.deepEqual(missingTemporaryMembers([{name:'Local Admin'}]),LOCAL_TEMPORARY_MEMBERS);
 assert.deepEqual(missingTemporaryMembers(LOCAL_TEMPORARY_MEMBERS.slice(0,8).map(name=>({name}))),['Omer','Shira']);
 assert.deepEqual(missingTemporaryMembers(LOCAL_TEMPORARY_MEMBERS.map(name=>({name}))),[]);
});

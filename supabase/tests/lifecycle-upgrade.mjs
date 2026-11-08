// Exercises the actual incremental conversion with realistic old-schema data.
// Accepts only an empty disposable LOCAL container; every fixture rolls back.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {snapshot,seed,manager,engineer} from './lifecycle-fixture.mjs';
const container=process.argv[2];
assert.match(container??'',/^supabase_db_[\w-]+$/);
const migration=readFileSync('supabase/migrations/20261018183148_draft_publication_lifecycle.sql','utf8').replace(/^\uFEFF/,'');
const sql=`begin;
${seed}
-- Divergent Published rows cannot be classified safely. Prove total rollback.
update public.duty_assignments set title='Ambiguous unpublished change' where publication_id is null and day='2027-12-06';
create function pg_temp.expect_conversion_refusal(expected_message text) returns void language plpgsql as $test$
declare before_state jsonb; previous_function text;
begin
 before_state:=(${snapshot});
 previous_function:=pg_get_functiondef('duty_private.cancel_draft(text,bigint)'::regprocedure);
 begin
  execute $migration$${migration}$migration$;
  raise exception 'Ambiguous conversion accepted';
 exception when raise_exception then
  if sqlerrm not like expected_message then raise; end if;
 end;
 if (${snapshot}) is distinct from before_state or pg_get_functiondef('duty_private.cancel_draft(text,bigint)'::regprocedure)<>previous_function then raise exception 'Failed migration partially committed'; end if;
end $test$;
select pg_temp.expect_conversion_refusal('Published month 2027-12 has divergent working data%');
update public.duty_assignments set title='' where publication_id is null and day='2027-12-06';
insert into public.duty_assignments(day,end_day,primary_id) values('2030-03-04','2030-03-05','${manager}');
select pg_temp.expect_conversion_refusal('Working duties have no owning month%');
delete from public.duty_assignments where day='2030-03-04';
update public.duty_months set current_publication_id=null where month='2027-12';
select pg_temp.expect_conversion_refusal('Published month 2027-12 has no publication%');
update public.duty_months set current_publication_id=(select id from public.duty_publications where month='2027-12' and version=2) where month='2027-12';
insert into public.duty_swap_requests(month,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,from_duty_id,to_duty_id)
select '2027-12','${manager}','${engineer}','2027-12-06','2027-12-07','2027-12-07','2027-12-08',a.id,b.id
from public.duty_assignments a cross join public.duty_assignments b where a.publication_id is null and b.publication_id is null and a.day='2027-12-06' and b.day='2027-12-07';
select pg_temp.expect_conversion_refusal('A request references working duties%');
delete from public.duty_swap_requests where month='2027-12';
create temp table expected as ${snapshot};
${migration}
do $test$
declare expected_state jsonb; actual_state jsonb;
begin
 select jsonb_build_object into expected_state from expected;
 expected_state:=jsonb_set(expected_state,'{duties}',(select jsonb_agg(row order by row->>'id') from jsonb_array_elements(expected_state->'duties') row where row->>'publication_id' is not null or duty_private.duty_owner((row->>'day')::date)<>'2027-12'));
 expected_state:=jsonb_set(expected_state,'{revision}','272');
 actual_state:=(${snapshot});
 if actual_state is distinct from expected_state then raise exception 'Conversion changed more than redundant published working rows and revision'; end if;
 if exists(select 1 from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='2027-12') then raise exception 'Published working copies survived conversion'; end if;
 if not exists(select 1 from public.duty_assignments where publication_id is null and day='2028-01-05' and title='Unpublished January special' and extra_points=7) then raise exception 'Reopened changes lost'; end if;
end $test$;
-- With no redundant published rows left, existing drafts still require a new
-- revision: invalidate an old implementation waiting to publish a reopened draft.
create temp table no_duplicates as ${snapshot};
${migration}
do $test$ begin
 if (${snapshot}) is distinct from (select jsonb_set(jsonb_build_object,'{revision}','273') from no_duplicates) then raise exception 'Workspace without duplicate rows was not invalidated safely'; end if;
end $test$;
rollback;`;
const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});
assert.equal(r.status,0,r.stderr);
console.log('PASS: actual migration preserves reopened/never-published drafts, full history, legacy adjacent rows, boundary specials, notes, requests and approvals; ambiguous data aborts atomically');

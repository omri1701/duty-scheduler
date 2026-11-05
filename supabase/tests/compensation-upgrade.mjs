// Rehearse the actual migration with prior-schema synthetic schedules. All DDL
// and fixtures roll back; refuse any nonempty database, including audit history.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {seed,snapshot} from './lifecycle-fixture.mjs';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const migration=readFileSync('supabase/migrations/'+readdirSync('supabase/migrations').find(f=>f.endsWith('_compensation_persistence.sql')),'utf8');
const previous=readFileSync('supabase/migrations/20261018183148_draft_publication_lifecycle.sql','utf8').replace(/^\uFEFF/,'');
const sql=`begin;
do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL';end if;
if to_regclass('public.duty_compensation_events') is not null then
 if exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty audit history';end if;
 execute 'drop trigger duty_compensation_member_insert on public.duty_members';
 execute 'drop trigger duty_compensation_member_update on public.duty_members';
 execute 'drop table public.duty_compensation_events';
end if;
-- The replayed migration defines the original four-argument signature; a later
-- optional argument would otherwise make its calls ambiguous.
drop function if exists duty_private.compensation_publication(text,uuid,jsonb,boolean,jsonb);
end$$;
${previous}
-- The earlier trigger implementation has no compensation hook.
create or replace function duty_private.reconcile_publication_swaps() returns trigger language plpgsql security definer set search_path='' as $$begin perform 1 from public.duty_workspace where id for update;perform duty_private.reconcile_swaps(new.month);return new;end$$;
${seed}
create temp table before_upgrade as ${snapshot};
-- Fail halfway through bootstrap. The entire table/function/trigger change and
-- revision increment must roll back; no user or unrelated row is discarded.
update public.duty_assignments set extra_points=0.25 where day='2027-12-06' and publication_id is not null;
do $test$begin
 begin execute $migration$${migration}$migration$;raise exception 'Malformed units accepted';
 exception when raise_exception then if sqlerrm<>'invalid-units' then raise;end if;end;
 if to_regclass('public.duty_compensation_events') is not null then raise exception 'Failed migration left a partial schema';end if;
end $test$;
update public.duty_assignments set extra_points=0 where day='2027-12-06' and publication_id is not null;
${migration}
do $test$declare actual jsonb;expected jsonb;s jsonb;begin
 actual:=(${snapshot});select jsonb_set(jsonb_build_object,'{revision}','272') into expected from before_upgrade;
 if actual<>expected then raise exception 'Upgrade changed users, schedules, private notes or unrelated data';end if;
 s:=duty_private.compensation_view(duty_private.compensation_state());
 if s->'claims'<>'[]' or s->'lots'<>'[]' or s->'settlements'<>'[]' then raise exception 'Historical debt was backfilled';end if;
 if jsonb_array_length(s->'publications')<>2 or jsonb_array_length(s->'members')<>2 then raise exception 'Missing zero-balance cutover facts';end if;
 if exists(select 1 from public.duty_compensation_events where operation::text like '%Private availability%') then raise exception 'Private note leaked into ledger';end if;
end $test$;
rollback;`;
const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});
assert.equal(r.status,0,r.stderr);
console.log('PASS: actual upgrade preserves identities, all versions/drafts, private notes, requests and unrelated rows; zero opening compensation; malformed units roll back the complete migration');

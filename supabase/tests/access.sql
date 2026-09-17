-- Run against a development project or through SQL Editor. All fixtures roll back.
begin;
do $$
declare
 manager_id uuid:=gen_random_uuid(); engineer_id uuid:=gen_random_uuid(); pending_id uuid:=gen_random_uuid();
 rev bigint; data jsonb; schedule jsonb; before_payload jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role) values
 (manager_id,manager_id||'@example.invalid',now(),false,'authenticated','authenticated'),
 (engineer_id,engineer_id||'@example.invalid',now(),false,'authenticated','authenticated'),
 (pending_id,pending_id||'@example.invalid',now(),false,'authenticated','authenticated');
 -- Do not change an existing team's manager reservation, even inside a rollback.
 if exists(select 1 from duty_private.manager_identity) then raise exception 'Run fixtures in an empty test project'; end if;
 insert into duty_private.manager_identity(email) values(manager_id||'@example.invalid');
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 set local role authenticated;
 perform public.duty_join('Manager');
 if (select role from public.duty_members where id=manager_id)<>'manager' then raise exception 'Manager bootstrap failed'; end if;
 select revision into rev from public.duty_workspace;
 perform public.duty_join('Manager');
 if (select revision from public.duty_workspace)<>rev then raise exception 'Repeat login changes revision'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 perform public.duty_join('Engineer');
 perform set_config('request.jwt.claim.sub',pending_id::text,true);
 perform public.duty_join('Pending');
 data:=public.duty_load();
 if jsonb_array_length(data->'members')<>1 or data->'revision'<>'null'::jsonb or data->'assignments'<>'[]'::jsonb or data->'months'<>'[]'::jsonb then raise exception 'Pending user sees team data'; end if;
 begin perform public.duty_review_member(pending_id,'approved',0); raise exception 'Self approval allowed'; exception when insufficient_privilege then null; end;
 begin update public.duty_members set role='manager' where id=pending_id; raise exception 'Direct privilege escalation allowed'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 select revision into rev from public.duty_workspace;
 perform public.duty_review_member(engineer_id,'approved',rev);
 select revision into rev from public.duty_workspace;
 -- Use a future month so the test does not depend on today's date.
 schedule:=jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('2099-10',jsonb_build_object('deadline','2099-09-25','status','draft','generated',true)),'specials','[]'::jsonb,'splitWeekends','[]'::jsonb,'assignments','{}'::jsonb);
 perform public.duty_save_schedule(schedule,rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace;
 perform public.duty_set_constraints(engineer_id,array['2099-10-01'::date],'no','Travel',rev);
 begin perform public.duty_set_constraints(engineer_id,array['2099-10-02'::date],'no','Stale',rev); raise exception 'Stale revision accepted'; exception when serialization_failure then null; end;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_constraints(manager_id,array['2099-10-02'::date],'no','Other person',rev); raise exception 'Other constraints writable'; exception when insufficient_privilege then null; end;
 begin perform public.duty_save_schedule(schedule,rev); raise exception 'Engineer can save manager draft'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 select revision into rev from public.duty_workspace;
 perform public.duty_set_constraints(manager_id,array['2099-10-02'::date],'prefer','Private manager note',rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 if (select count(*) from public.duty_constraints)<>1 then raise exception 'Another member constraints visible'; end if;
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 select revision into rev from public.duty_workspace;
 begin perform public.duty_save_schedule(schedule,rev,'2099-10'); raise exception 'Incomplete publication accepted'; exception when raise_exception then if sqlerrm='Incomplete publication accepted' then raise; end if; end;
 select jsonb_set(schedule,'{assignments}',jsonb_object_agg(to_char(d,'YYYY-MM-DD'),jsonb_build_object('primary',manager_id))) into schedule from generate_series('2099-10-01'::date,'2099-11-01'::date,interval '1 day') d;
 perform public.duty_save_schedule(schedule,rev,'2099-10');
 select payload into before_payload from public.duty_publications where month='2099-10';
 if before_payload->'assignments' ? '2099-11-01' then raise exception 'Neighboring month draft leaked'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_constraints(engineer_id,array['2099-10-02'::date],'prefer','After publication',rev); raise exception 'Published constraints writable'; exception when insufficient_privilege then null; end;
 data:=public.duty_load();
 if data->'assignments'<>'[]'::jsonb or jsonb_array_length(data->'publications')<>1 then raise exception 'Published/draft access incorrect'; end if;
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 schedule:=jsonb_set(schedule,'{assignments,2099-10-01,primary}',to_jsonb(engineer_id::text));
 perform public.duty_save_schedule(schedule,rev);
 if (select payload from public.duty_publications where month='2099-10')<>before_payload then raise exception 'Draft changed published schedule'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_save_schedule(schedule,rev,'2099-10'); raise exception 'Unavailable assignment published'; exception when raise_exception then if sqlerrm='Unavailable assignment published' then raise; end if; end;
 schedule:=jsonb_set(schedule,'{assignments,2099-10-01,override}','true'::jsonb);
 perform public.duty_save_schedule(schedule,rev,'2099-10');
 select revision into rev from public.duty_workspace;
 schedule:=jsonb_set(schedule,'{months,2099-10,deadline}','"2000-01-01"'::jsonb);
 perform public.duty_save_schedule(schedule,rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_constraints(engineer_id,array['2099-10-02'::date],'prefer','Late',rev); raise exception 'Expired deadline ignored'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',manager_id::text,true);
 select revision into rev from public.duty_workspace;
 -- July 2026 ends on Friday. A special Saturday belongs to that weekend too.
 schedule:=jsonb_set(schedule,'{months,2026-07}','{"deadline":"2026-06-24","status":"draft","generated":true}'::jsonb);
 schedule:=jsonb_set(schedule,'{specials}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'title','Special Saturday','start','2026-08-01','end','2026-08-02','extra',2)));
 select jsonb_set(schedule,'{assignments}',schedule->'assignments'||jsonb_object_agg(to_char(d,'YYYY-MM-DD'),jsonb_build_object('primary',manager_id))) into schedule from generate_series('2026-07-01'::date,'2026-08-01'::date,interval '1 day') d;
 perform public.duty_save_schedule(schedule,rev,'2026-07');
 if not (select payload->'assignments' ? '2026-08-01' from public.duty_publications where month='2026-07') then raise exception 'Boundary special Saturday omitted'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 reset role;
 update public.duty_members set active=false where id=engineer_id;
 set local role authenticated;
 data:=public.duty_load();
 if data->'revision'<>'null'::jsonb or data->'publications'<>'[]'::jsonb then raise exception 'Inactive member still has access'; end if;
 set local role anon;
 begin perform public.duty_load(); raise exception 'Anonymous access allowed'; exception when insufficient_privilege then null; end;
 reset role;
end $$;
select 'PASS: manager reservation, approval, RLS, direct writes, ownership, revisions, deadlines, publish validation, draft isolation, boundary weekends, inactive and anonymous access' as result;
rollback;

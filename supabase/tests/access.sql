-- Synthetic fixtures only; the entire transaction rolls back without sending email.
begin;
do $$
declare
 admin_id uuid:=gen_random_uuid(); engineer_id uuid:=gen_random_uuid(); second_id uuid:=gen_random_uuid(); pending_id uuid:=gen_random_uuid();
 rev bigint; data jsonb; schedule jsonb; version_one uuid; version_two uuid; boundary_version uuid; value numeric; kept uuid;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Run fixtures in an empty development project'; end if;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role) values
 (admin_id,admin_id||'@example.invalid',now(),false,'authenticated','authenticated'),
 (engineer_id,engineer_id||'@example.invalid',now(),false,'authenticated','authenticated'),
 (second_id,second_id||'@example.invalid',now(),false,'authenticated','authenticated'),
 (pending_id,pending_id||'@example.invalid',now(),false,'authenticated','authenticated');
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 set local role authenticated;
 perform public.duty_join('Google Admin Name');
 if (select role from public.duty_members where id=admin_id)<>'engineer' or (select status from public.duty_members where id=admin_id)<>'pending' then raise exception 'First signup was auto-approved'; end if;
 begin update public.duty_members set role='admin',status='approved',active=true where id=admin_id; raise exception 'Self approval allowed'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); perform public.duty_join('Google Engineer Name');
 perform set_config('request.jwt.claim.sub',second_id::text,true); perform public.duty_join('Second Admin');
 perform set_config('request.jwt.claim.sub',pending_id::text,true); perform public.duty_join('Pending');
 data:=public.duty_load();
 if jsonb_array_length(data->'members')<>1 or data->'revision'<>'null'::jsonb or data->'assignments'<>'[]'::jsonb then raise exception 'Pending user sees team data'; end if;
 begin perform public.duty_set_role(pending_id,'admin',0); raise exception 'Pending user can promote'; exception when insufficient_privilege then null; end;
 -- Simulate explicit, trusted promotion after the owner identifies their first account.
 reset role;
 update public.duty_members set role='admin',status='approved',active=true where id=admin_id;
 update public.duty_workspace set revision=revision+1;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 set local role authenticated;
 select revision into rev from public.duty_workspace;
 perform public.duty_join('New Google Name');
 if (select revision from public.duty_workspace)<>rev or (select name from public.duty_members where id=admin_id)<>'Google Admin Name' then raise exception 'Repeat signup changed profile/revision'; end if;
 perform public.duty_review_member(engineer_id,'approved',rev);
 select revision into rev from public.duty_workspace;perform public.duty_review_member(second_id,'approved',rev);
 select revision into rev from public.duty_workspace;perform public.duty_set_role(second_id,'admin',rev);
 if (select count(*) from public.duty_members where role='admin')<>2 then raise exception 'Multiple admins not supported'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_role(engineer_id,'invented',rev); raise exception 'Unknown FK role accepted'; exception when foreign_key_violation then null; end;
 perform public.duty_set_role(second_id,'engineer',rev);
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_role(admin_id,'engineer',rev); raise exception 'Last admin removed'; exception when raise_exception then if sqlerrm='Last admin removed' then raise; end if; end;
 perform public.duty_set_role(second_id,'admin',rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace;perform public.duty_rename_self('My chosen name',rev);
 perform public.duty_join('Google Engineer Name');
 if (select name from public.duty_members where id=engineer_id)<>'My chosen name' or (select role from public.duty_members where id=engineer_id)<>'engineer' then raise exception 'Profile rename not isolated'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_role(engineer_id,'admin',rev); raise exception 'Engineer privilege escalation'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 select revision into rev from public.duty_workspace;
 schedule:=jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('2099-10',jsonb_build_object('deadline','2099-09-25','status','draft','generated',true)),'duties','[]'::jsonb);
 perform public.duty_save_schedule(schedule,rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace;perform public.duty_set_constraints(engineer_id,array['2099-10-01'::date],'no','Travel',rev);
 begin perform public.duty_set_constraints(engineer_id,array['2099-10-02'::date],'no','Stale',rev); raise exception 'Stale revision accepted'; exception when serialization_failure then null; end;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_constraints(admin_id,array['2099-10-02'::date],'no','Other person',rev); raise exception 'Other constraints writable'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',second_id::text,true);
 perform public.duty_set_constraints(admin_id,array['2099-10-02'::date],'prefer','Private admin note',rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 if (select count(*) from public.duty_constraints)<>1 then raise exception 'Private note leaked'; end if;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 select revision into rev from public.duty_workspace;
 begin perform public.duty_save_schedule(schedule,rev,'2099-10'); raise exception 'Incomplete publication accepted'; exception when raise_exception then if sqlerrm='Incomplete publication accepted' then raise; end if; end;
 select jsonb_set(schedule,'{duties}',jsonb_agg(jsonb_build_object('day',d::date,'end_day',d::date+1,'primary_id',admin_id,'title',case when d::date='2099-10-04'::date then 'Holiday' else '' end,'extra_points',case when d::date='2099-10-04'::date then 2 else 0 end))) into schedule from generate_series('2099-10-01'::date,'2099-10-31'::date,interval '1 day') d;
 perform public.duty_save_schedule(schedule,rev,'2099-10');
 select current_publication_id into version_one from public.duty_months where month='2099-10';
 select points into value from public.duty_assignments where publication_id=version_one and day='2099-10-04';
 -- Update only the engineer field; holiday points must remain unchanged.
 schedule:=jsonb_set(schedule,'{duties,3,primary_id}',to_jsonb(second_id::text));
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev);
 if (select primary_id from public.duty_assignments where publication_id=version_one and day='2099-10-04')<>admin_id then raise exception 'Draft changed a saved version'; end if;
 if (select points from public.duty_assignments where publication_id is null and day='2099-10-04')<>value then raise exception 'Reassignment changed holiday points'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 if exists(select 1 from public.duty_assignments where publication_id is null) then raise exception 'Draft leaked'; end if;
 if (select count(*) from public.duty_publications)<>1 then raise exception 'Live version not visible'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_restore_publication(version_one,rev); raise exception 'Engineer restored draft'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 perform public.duty_save_schedule(schedule,rev,'2099-10');
 select current_publication_id into version_two from public.duty_months where month='2099-10';
 if version_two=version_one or (select count(*) from public.duty_publications)<>2 then raise exception 'Version history overwritten'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 if (select count(*) from public.duty_publications)<>1 or exists(select 1 from public.duty_assignments where publication_id=version_one) then raise exception 'Unpublished history leaked'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_set_constraints(engineer_id,array['2099-10-02'::date],'prefer','After publication',rev); raise exception 'Published month writable'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',second_id::text,true);
 perform public.duty_restore_publication(version_one,rev);
 if (select primary_id from public.duty_assignments where publication_id is null and day='2099-10-04')<>admin_id then raise exception 'Restore did not restore assignment'; end if;
 if (select current_publication_id from public.duty_months where month='2099-10')<>version_two or (select status from public.duty_months where month='2099-10')<>'draft' then raise exception 'Restore changed live publication'; end if;
 select revision into rev from public.duty_workspace;perform public.duty_delete_publication(version_two,rev);
 if (select current_publication_id from public.duty_months where month='2099-10')<>version_one or exists(select 1 from public.duty_assignments where publication_id=version_two) then raise exception 'Version deletion/fallback failed'; end if;
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev,'2099-10');
 if (select max(version) from public.duty_publications where month='2099-10')<>3 then raise exception 'Version number reused after deletion'; end if;
 select current_publication_id into kept from public.duty_months where month='2099-10';
 select revision into rev from public.duty_workspace;perform public.duty_delete_publication(version_one,rev);
 if (select current_publication_id from public.duty_months where month='2099-10')<>kept then raise exception 'Deleting old version changed current version'; end if;
 -- Special Saturday at a month boundary stays in Friday's publication.
 schedule:=jsonb_set(schedule,'{months,2026-07}','{"deadline":"2026-06-24","status":"draft","generated":true}'::jsonb);
 schedule:=jsonb_set(schedule,'{months,2026-08}','{"deadline":"2026-07-24","status":"draft","generated":true}'::jsonb);
 select jsonb_set(schedule,'{duties}',schedule->'duties'||jsonb_agg(jsonb_build_object('day',d::date,'end_day',d::date+case when extract(dow from d)=5 and d::date<>'2026-07-31'::date then 2 else 1 end,'primary_id',admin_id,'title',case when d::date='2026-08-01'::date then 'Boundary holiday' else '' end,'extra_points',case when d::date='2026-08-01'::date then 2 else 0 end))) into schedule from generate_series('2026-07-01'::date,'2026-08-31'::date,interval '1 day') d where extract(dow from d)<>6 or d::date='2026-08-01'::date;
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev,'2026-08');
 select current_publication_id into boundary_version from public.duty_months where month='2026-08';
 -- Replace the old split with a combined Friday, then restore the August snapshot.
 select jsonb_set(schedule,'{duties}',jsonb_agg(case when entry->>'day'='2026-07-31' then jsonb_set(entry,'{end_day}','"2026-08-02"'::jsonb) else entry end)) into schedule from jsonb_array_elements(schedule->'duties') entry where entry->>'day'<>'2026-08-01';
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev);
 select revision into rev from public.duty_workspace;perform public.duty_restore_publication(boundary_version,rev);
 if (select end_day from public.duty_assignments where publication_id is null and day='2026-07-31')<>'2026-08-01'::date then raise exception 'Restoring August erased the July Friday half'; end if;
 if (select points from public.duty_assignments where publication_id is null and day='2026-08-01')<>2.5 then raise exception 'Boundary holiday lost its extra points'; end if;
 -- Rebuild the payload from the restored draft for the next publish.
 select jsonb_set(schedule,'{duties}',jsonb_agg(to_jsonb(a))) into schedule from public.duty_assignments a where publication_id is null;
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev,'2026-07');
 if not exists(select 1 from public.duty_assignments where publication_id=(select current_publication_id from public.duty_months where month='2026-07') and day='2026-08-01' and points=2.5) then raise exception 'July publication omitted special Saturday'; end if;
 select revision into rev from public.duty_workspace;perform public.duty_delete_publication(kept,rev);
 if (select current_publication_id from public.duty_months where month='2099-10') is not null or (select status from public.duty_months where month='2099-10')<>'draft' then raise exception 'Deleting the last version left month published'; end if;
 -- Deactivation retains published references and blocks that member's workspace access.
 schedule:=jsonb_set(schedule,'{team}',jsonb_build_array(jsonb_build_object('id',engineer_id,'name','Ignored spoof','role','admin','color','#adc9ee','active',false)));
 select revision into rev from public.duty_workspace;perform public.duty_save_schedule(schedule,rev);
 if (select name from public.duty_members where id=engineer_id)<>'My chosen name' or (select role from public.duty_members where id=engineer_id)<>'engineer' then raise exception 'Bulk save overwrote profile or role'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 data:=public.duty_load();
 if data->'revision'<>'null'::jsonb or data->'publications'<>'[]'::jsonb or data->'assignments'<>'[]'::jsonb then raise exception 'Inactive member still has access'; end if;
 set local role anon;
 begin perform public.duty_load(); raise exception 'Anonymous access allowed'; exception when insufficient_privilege then null; end;
 reset role;
end $$;
select 'PASS: pending first signup, explicit bootstrap, two admins, last-admin protection, FK lookups, own profile, RLS, private notes, stale revisions, validation, stable points, boundary restore/publication, immutable versions, restore, delete, version numbering, deactivation and anonymous access' as result;
rollback;

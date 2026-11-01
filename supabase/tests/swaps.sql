-- Run only on an empty local/development database. All synthetic data rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare
 admin_id uuid:=gen_random_uuid(); engineer_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); cover_id uuid:=gen_random_uuid(); pending_id uuid:=gen_random_uuid();
 pub uuid; new_pub uuid; from_id uuid; to_id uuid; weekend_id uuid; split_id uuid; request_id uuid; competing uuid; rev bigint; before_rows jsonb; draft_rows jsonb;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Run fixtures in an empty development project'; end if;
 if has_function_privilege('authenticated','duty_private.reconcile_swaps(text)','EXECUTE')
  or has_function_privilege('anon','duty_private.reconcile_swaps(text)','EXECUTE')
  or has_function_privilege('authenticated','duty_private.reconcile_publication_swaps()','EXECUTE')
  or has_function_privilege('authenticated','duty_private.reconcile_member_swaps()','EXECUTE')
  or has_function_privilege('anon','duty_private.reconcile_publication_swaps()','EXECUTE')
  or has_function_privilege('authenticated','duty_private.validate_swap(uuid,uuid,uuid,boolean)','EXECUTE')
  or has_function_privilege('anon','duty_private.validate_swap(uuid,uuid,uuid,boolean)','EXECUTE') then raise exception 'Internal helper exposed'; end if;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
 select id,id||'@example.invalid',now(),false,'authenticated','authenticated' from unnest(array[admin_id,engineer_id,other_id,cover_id,pending_id]) id;
 insert into public.duty_members(id,email,name,role,status,active)
 values(admin_id,admin_id||'@example.invalid','Admin','admin','approved',true),
 (engineer_id,engineer_id||'@example.invalid','Engineer','engineer','approved',true),
 (other_id,other_id||'@example.invalid','Other','engineer','approved',true),
 (cover_id,cover_id||'@example.invalid','Cover','engineer','approved',true),
 (pending_id,pending_id||'@example.invalid','Pending','engineer','pending',false);
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2099-10','2099-09-25','draft',1);
 insert into public.duty_publications(month,version,published_by) values('2099-10',1,admin_id) returning id into pub;
 update public.duty_months set current_publication_id=pub where month='2099-10';
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,title,extra_points)
 values(pub,'2099-10-05','2099-10-06',engineer_id,cover_id,'Special',3) returning id into from_id;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id)
 values(pub,'2099-10-06','2099-10-07',other_id,cover_id) returning id into to_id;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2099-10-02','2099-10-04',engineer_id) returning id into weekend_id;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-10-09','2099-10-10',other_id);
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2099-10-10','2099-10-11',other_id) returning id into split_id;
 -- Unrelated draft deliberately differs from the live version.
 insert into public.duty_assignments(day,end_day,primary_id,title,extra_points) values('2099-10-05','2099-10-06',admin_id,'Unrelated draft',7);
 select jsonb_agg(to_jsonb(a) order by day) into before_rows from public.duty_assignments a where publication_id=pub;
 select jsonb_agg(to_jsonb(a) order by day) into draft_rows from public.duty_assignments a where publication_id is null;

 perform set_config('request.jwt.claim.sub',pending_id::text,true); set local role authenticated;
 if (public.duty_load()->'swapRequests')<>'[]'::jsonb then raise exception 'Pending sees requests'; end if;
 begin perform public.duty_request_swap(from_id,to_id,'',0); raise exception 'Pending can request'; exception when insufficient_privilege then null; end;
 reset role; perform set_config('request.jwt.claim.sub','',true); set local role anon;
 begin perform public.duty_request_swap(from_id,to_id,'',0); raise exception 'Anon can request'; exception when insufficient_privilege then null; end;
 begin perform 1 from public.duty_swap_requests; raise exception 'Anon can read'; exception when insufficient_privilege then null; end;
 reset role; perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_request_swap(to_id,from_id,'',rev); raise exception 'Can request someone else duty'; exception when insufficient_privilege then null; end;
 begin perform public.duty_request_swap(from_id,from_id,'',rev); raise exception 'Same duty accepted'; exception when raise_exception then if sqlerrm='Same duty accepted' then raise; end if; end;
 begin perform public.duty_request_swap(from_id,split_id,'',rev); raise exception 'Second weekend accepted'; exception when raise_exception then if sqlerrm='Second weekend accepted' then raise; end if; end;
 perform public.duty_request_swap(from_id,to_id,'Optional explanation',rev);
 select id into request_id from public.duty_swap_requests;
 if request_id is null or (public.duty_load()->'swapRequests'->0->>'explanation')<>'Optional explanation' then raise exception 'Request not persisted'; end if;
 begin update public.duty_swap_requests set status='approved'; raise exception 'Direct write allowed'; exception when insufficient_privilege then null; end;
 begin perform public.duty_resolve_swap(request_id,'approve',rev+1); raise exception 'Engineer can approve'; exception when insufficient_privilege then null; end;
 begin perform public.duty_resolve_swap(request_id,'reject',rev+1); raise exception 'Engineer can reject'; exception when insufficient_privilege then null; end;
 begin perform public.duty_request_swap(from_id,to_id,'Stale',rev); raise exception 'Stale revision allowed'; exception when serialization_failure then null; end;
 begin perform public.duty_request_swap(from_id,to_id,'Duplicate',rev+1); raise exception 'Duplicate pending pair allowed'; exception when unique_violation then null; end;
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 if not exists(select 1 from public.duty_swap_requests where id=request_id and status='awaiting_engineer') then raise exception 'Counterpart cannot see incoming request'; end if;
 begin perform public.duty_resolve_swap(request_id,'cancel',rev+1); raise exception 'Other engineer can cancel'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',cover_id::text,true);
 if exists(select 1 from public.duty_swap_requests) then raise exception 'Unrelated engineer sees request'; end if;
 begin perform public.duty_resolve_swap(request_id,'accept',rev+1); raise exception 'Unrelated consent allowed'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 begin perform public.duty_resolve_swap(request_id,'approve',rev+1); raise exception 'Approval before consent allowed'; exception when raise_exception then if sqlerrm='Approval before consent allowed' then raise; end if; end;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 begin perform public.duty_resolve_swap(request_id,'accept',rev+1); raise exception 'Requester can consent for counterpart'; exception when insufficient_privilege then null; end;
 perform public.duty_resolve_swap(request_id,'cancel',rev+1);
 if (select status from public.duty_swap_requests where id=request_id)<>'cancelled' then raise exception 'Cancel failed'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(request_id,'cancel',rev); raise exception 'Double cancellation allowed'; exception when raise_exception then if sqlerrm='Double cancellation allowed' then raise; end if; end;
 perform public.duty_request_swap(from_id,to_id,'Reject me',rev);
 select id into request_id from public.duty_swap_requests where status='awaiting_engineer';
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(request_id,'accept',rev);
 if exists(select 1 from public.duty_swap_requests where id=request_id) then raise exception 'Consent-stage visibility not removed'; end if;
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 if not exists(select 1 from public.duty_swap_requests where id=request_id and status='awaiting_admin') then raise exception 'Admin cannot see accepted request'; end if;
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(request_id,'reject',rev);
 if (select status from public.duty_swap_requests where id=request_id)<>'rejected' then raise exception 'Rejection failed'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(from_id,to_id,'Decline me',rev);
 select id into request_id from public.duty_swap_requests where status='awaiting_engineer';
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(request_id,'decline',rev);
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 if (select status from public.duty_swap_requests where id=request_id)<>'declined' then raise exception 'Decline not persisted'; end if;
 reset role;
 if before_rows is distinct from (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id=pub) then raise exception 'Request/cancel/reject mutated publication'; end if;

 -- Request-time unavailability is checked without exposing private notes.
 insert into public.duty_constraints values(engineer_id,'2099-10-06','no','Private');
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_request_swap(from_id,to_id,'',rev); raise exception 'Unavailable request accepted'; exception when raise_exception then if sqlerrm='Unavailable request accepted' then raise; end if; end;
 reset role; delete from public.duty_constraints;
 set local role authenticated; perform public.duty_request_swap(from_id,to_id,'Approve me',rev);
 select id into request_id from public.duty_swap_requests where status='awaiting_engineer';
 -- Another pending request will become stale when this publication is superseded.
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(to_id,from_id,'Concurrent source version',rev);
 select id into competing from public.duty_swap_requests where status='awaiting_engineer' and requester_id=auth.uid();
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(request_id,'accept',rev);
 reset role; insert into public.duty_constraints values(engineer_id,'2099-10-06','no','Do not leak this note');
 update public.duty_members set active=false where id=other_id;
 perform set_config('request.jwt.claim.sub',admin_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(request_id,'approve',rev,'Admin exception'); raise exception 'Inactive approval accepted'; exception when raise_exception then if sqlerrm='Inactive approval accepted' then raise; end if; end;
 reset role; update public.duty_members set active=true where id=other_id;
 set local role authenticated;
 begin perform public.duty_resolve_swap(request_id,'approve',rev); raise exception 'Unavailable approval accepted'; exception when raise_exception then if sqlerrm='Unavailable approval accepted' then raise; end if; end;
 perform public.duty_resolve_swap(request_id,'approve',rev,'Explicit availability exception');
 select current_publication_id into new_pub from public.duty_months where month='2099-10';
 if new_pub=pub or (select version from public.duty_publications where id=new_pub)<>2 then raise exception 'Approval did not create a new version'; end if;
 if (select status from public.duty_months where month='2099-10')<>'draft' then raise exception 'Approval published unrelated draft'; end if;
 if (select primary_id from public.duty_assignments where publication_id=new_pub and day='2099-10-05')<>other_id
  or (select primary_id from public.duty_assignments where publication_id=new_pub and day='2099-10-06')<>engineer_id then raise exception 'Primaries not exchanged'; end if;
 if (select override_reason from public.duty_swap_requests where id=request_id)<>'Explicit availability exception' then raise exception 'Override not audited'; end if;
 if (select manager_override from public.duty_assignments where publication_id=new_pub and day='2099-10-05')
  or not (select manager_override from public.duty_assignments where publication_id=new_pub and day='2099-10-06') then raise exception 'Override must apply only to conflicting dates'; end if;
 begin perform public.duty_resolve_swap(competing,'approve',rev); raise exception 'Concurrent stale revision accepted'; exception when serialization_failure then null; end;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(competing,'approve',rev,'Exception'); raise exception 'Superseded publication approved'; exception when raise_exception then if sqlerrm='Superseded publication approved' then raise; end if; end;
 begin perform public.duty_resolve_swap(request_id,'approve',rev); raise exception 'Double approval accepted'; exception when raise_exception then if sqlerrm='Double approval accepted' then raise; end if; end;
 reset role; if (select status from public.duty_swap_requests where id=competing)<>'invalidated' then raise exception 'Lost requester ownership not invalidated'; end if; set local role authenticated;
 reset role;
 if before_rows is distinct from (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id=pub) then raise exception 'Historical publication changed'; end if;
 if draft_rows is distinct from (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null) then raise exception 'Draft changed'; end if;
 if exists(select 1 from public.duty_assignments old join public.duty_assignments fresh on fresh.day=old.day and fresh.publication_id=new_pub
  where old.publication_id=pub and (old.secondary_id is distinct from fresh.secondary_id or old.end_day<>fresh.end_day or old.points<>fresh.points or old.title<>fresh.title or old.extra_points<>fresh.extra_points)) then raise exception 'Secondary/points/weekend grouping changed'; end if;
 if (select count(*) from public.duty_assignments where publication_id=new_pub)<>(select count(*) from public.duty_assignments where publication_id=pub) then raise exception 'Publication coverage changed'; end if;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 if (public.duty_load()->'swapRequests')::text like '%Do not leak this note%' then raise exception 'Private note leaked'; end if;
 reset role; update public.duty_members set active=false where id=engineer_id;
 set local role authenticated;
 if exists(select 1 from public.duty_swap_requests) then raise exception 'Inactive requester sees requests'; end if;
 begin perform public.duty_resolve_swap(request_id,'cancel',(select revision from public.duty_workspace)); raise exception 'Inactive can cancel'; exception when insufficient_privilege then null; end;
end $$;
-- Boundary ownership, whole/split weekends and failed-validation atomicity.
reset role;
do $$
declare
 admin_id uuid:=(select id from public.duty_members where name='Admin');
 engineer_id uuid:=(select id from public.duty_members where name='Engineer');
 other_id uuid:=(select id from public.duty_members where name='Other');
 pub uuid; adjacent uuid; result uuid; a uuid; b uuid; extra uuid; req uuid; rev bigint; current_month text; today date:=(now() at time zone 'Asia/Jerusalem')::date;
begin
 update public.duty_members set active=true where status='approved'; delete from public.duty_constraints;
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2099-07','2099-06-25','published',1),('2099-08','2099-07-25','published',1);
 insert into public.duty_publications(month,version,published_by) values('2099-07',1,admin_id) returning id into pub;
 insert into public.duty_publications(month,version,published_by) values('2099-08',1,admin_id) returning id into adjacent;
 update public.duty_months set current_publication_id=pub where month='2099-07';
 update public.duty_months set current_publication_id=adjacent where month='2099-08';
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-07-31','2099-08-02',engineer_id) returning id into a;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-07-27','2099-07-28',other_id) returning id into b;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(adjacent,'2099-07-31','2099-08-02',engineer_id) returning id into extra;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_request_swap(a,extra,'',rev); raise exception 'Cross-publication request accepted'; exception when raise_exception then if sqlerrm='Cross-publication request accepted' then raise; end if; end;
 begin perform public.duty_request_swap(extra,b,'',rev); raise exception 'Carried wrong-month duty accepted'; exception when raise_exception then if sqlerrm='Carried wrong-month duty accepted' then raise; end if; end;
 perform public.duty_request_swap(a,b,'Boundary combined weekend',rev);
 select id into req from public.duty_swap_requests where status='awaiting_engineer' and month='2099-07';
 perform set_config('request.jwt.claim.sub',other_id::text,true); perform public.duty_resolve_swap(req,'accept',rev+1);
 select revision into rev from public.duty_workspace; rev:=rev-1;
 reset role; update public.duty_members set status='pending' where id=admin_id;
 perform set_config('request.jwt.claim.sub',admin_id::text,true); set local role authenticated;
 begin perform public.duty_resolve_swap(req,'approve',rev+1); raise exception 'Pending admin approved'; exception when insufficient_privilege then null; end;
 reset role; update public.duty_members set status='approved',active=false where id=admin_id;
 set local role authenticated;
 begin perform public.duty_resolve_swap(req,'reject',rev+1); raise exception 'Inactive admin rejected'; exception when insufficient_privilege then null; end;
 reset role; update public.duty_members set active=true where id=admin_id;
 -- Published overlap revalidated after submission.
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-08-01','2099-08-02',other_id) returning id into extra;
 set local role authenticated;
 begin perform public.duty_resolve_swap(req,'approve',rev+1); raise exception 'Overlapping approval accepted'; exception when raise_exception then if sqlerrm='Overlapping approval accepted' then raise; end if; end;
 reset role; delete from public.duty_assignments where id=extra;
 set local role authenticated; perform public.duty_resolve_swap(req,'approve',rev+1);
 select current_publication_id into result from public.duty_months where month='2099-07';
 if not exists(select 1 from public.duty_assignments where publication_id=result and day='2099-07-31' and end_day='2099-08-02' and primary_id=other_id and points=1) then raise exception 'Combined boundary weekend broken'; end if;
 if not exists(select 1 from public.duty_assignments where publication_id=adjacent and day='2099-07-31' and primary_id=engineer_id) then raise exception 'Adjacent history edited'; end if;
 reset role;
 -- Split boundary Saturday belongs to July, not August; two halves stay independent.
 insert into public.duty_publications(month,version,published_by) values('2099-07',3,admin_id) returning id into pub;
 update public.duty_months set current_publication_id=pub,publication_sequence=3 where month='2099-07';
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-07-31','2099-08-01',engineer_id) returning id into a;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-08-01','2099-08-02',other_id) returning id into b;
 perform set_config('request.jwt.claim.sub',other_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(b,a,'Split Saturday',rev);
 select id into req from public.duty_swap_requests where status='awaiting_engineer' and requester_id=auth.uid();
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); perform public.duty_resolve_swap(req,'accept',rev+1);
 perform set_config('request.jwt.claim.sub',admin_id::text,true); perform public.duty_resolve_swap(req,'approve',rev+2);
 select current_publication_id into result from public.duty_months where month='2099-07';
 if (select count(*) from public.duty_assignments where publication_id=result and end_day=day+1 and points=0.5)<>2 then raise exception 'Split weekend recombined or points changed'; end if;
 reset role;
 -- Yesterday is excluded in Israel; deterministic today/midnight coverage follows below.
 current_month:=to_char(today,'YYYY-MM');
 insert into public.duty_months(month,deadline,publication_sequence) values(current_month,today,1);
 insert into public.duty_publications(month,version,published_by) values(current_month,1,admin_id) returning id into pub;
 update public.duty_months set current_publication_id=pub where month=current_month;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,today,today+1,engineer_id) returning id into a;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,today+2,today+3,other_id) returning id into b;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 reset role; update public.duty_assignments set day=today-1,end_day=today where id=a;
 set local role authenticated;
 begin perform public.duty_request_swap(a,b,'',rev); raise exception 'Past duty accepted'; exception when raise_exception then if sqlerrm='Past duty accepted' then raise; end if; end;
end $$;
-- Pending requests track their original slots across versions; consent tracks
-- the current owner, not the original counterpart or original row UUID.
reset role;
do $$
declare
 admin_id uuid:=(select id from public.duty_members where name='Admin');
 a_id uuid:=(select id from public.duty_members where name='Engineer');
 b_id uuid:=(select id from public.duty_members where name='Other');
 c_id uuid:=(select id from public.duty_members where name='Cover');
 pub uuid; newer uuid; x uuid; y uuid; z uuid; r uuid; competing uuid; rev bigint; consent timestamptz; original jsonb;
begin
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2099-11','2099-10-25','published',1);
 insert into public.duty_publications(month,version,published_by) values('2099-11',1,admin_id) returning id into pub;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2099-11-02','2099-11-03',a_id) returning id into x;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2099-11-03','2099-11-04',b_id) returning id into y;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2099-11-04','2099-11-05',c_id) returning id into z;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2099-11-05','2099-11-06',admin_id);
 update public.duty_months set current_publication_id=pub where month='2099-11';
 select jsonb_agg(to_jsonb(d) order by day) into original from public.duty_assignments d where publication_id=pub;
 perform set_config('request.jwt.claim.sub',a_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(x,y,'A requests original X and Y',rev);
 select id into r from public.duty_swap_requests where month='2099-11' and requester_id=a_id;
 perform set_config('request.jwt.claim.sub',b_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(r,'accept',rev);
 perform set_config('request.jwt.claim.sub',c_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(z,y,'C swaps with B first',rev);
 select id into competing from public.duty_swap_requests where month='2099-11' and requester_id=c_id;
 perform set_config('request.jwt.claim.sub',b_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(competing,'accept',rev);
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(competing,'approve',rev);
 begin perform public.duty_resolve_swap(r,'approve',rev); raise exception 'Stale consent approved'; exception when serialization_failure then null; end;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(r,'approve',rev); raise exception 'Earlier B consent reused'; exception when raise_exception then if sqlerrm='Earlier B consent reused' then raise; end if; end;
 reset role;
 if not exists(select 1 from public.duty_swap_requests where id=r and other_id=c_id and status='awaiting_engineer' and accepted_by is null and accepted_at is null
  and from_duty_id=x and to_duty_id=y and source_publication_id=pub) then raise exception 'Counterpart/consent/original slots not reconciled'; end if;
 perform set_config('request.jwt.claim.sub',b_id::text,true); set local role authenticated;
 if exists(select 1 from public.duty_swap_requests where id=r) then raise exception 'Former B can read reassigned explanation'; end if;
 begin perform public.duty_resolve_swap(r,'accept',rev); raise exception 'Former B can accept'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',c_id::text,true);
 if not exists(select 1 from public.duty_swap_requests where id=r) then raise exception 'Current C cannot read request'; end if;
 perform public.duty_resolve_swap(r,'accept',rev);
 reset role;
 select accepted_at into consent from public.duty_swap_requests where id=r;
 -- Normal admin publication changing ONLY an unrelated slot must preserve consent.
 insert into public.duty_publications(month,version,published_by) values('2099-11',3,admin_id) returning id into newer;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,title,extra_points)
 select newer,day,end_day,case when day='2099-11-05' then b_id else primary_id end,secondary_id,title,extra_points
 from public.duty_assignments where publication_id=(select current_publication_id from public.duty_months where month='2099-11');
 update public.duty_months set current_publication_id=newer,publication_sequence=3 where month='2099-11';
 if not exists(select 1 from public.duty_swap_requests where id=r and status='awaiting_admin' and accepted_by=c_id and accepted_at=consent) then raise exception 'Unrelated changes reset consent'; end if;
 -- Deleting the original source history does not delete the original slot identity.
 perform set_config('request.jwt.claim.sub',admin_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace; perform public.duty_delete_publication(pub,rev);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(r,'approve',rev);
 select current_publication_id into newer from public.duty_months where month='2099-11';
 if not exists(select 1 from public.duty_assignments where publication_id=newer and day='2099-11-02' and primary_id=c_id)
  or not exists(select 1 from public.duty_assignments where publication_id=newer and day='2099-11-03' and primary_id=a_id) then raise exception 'Resolved slots swapped wrong owners'; end if;
 if (select version from public.duty_publications where id=newer)<>4 then raise exception 'Publication sequence reused'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(r,'approve',rev); raise exception 'Double approval allowed'; exception when raise_exception then if sqlerrm='Double approval allowed' then raise; end if; end;
 -- New request invalidates if A loses their own original slot on publication.
 perform set_config('request.jwt.claim.sub',a_id::text,true);
 select id into x from public.duty_assignments where publication_id=newer and day='2099-11-03';
 select id into y from public.duty_assignments where publication_id=newer and day='2099-11-04';
 perform public.duty_request_swap(x,y,'Lost requester',rev);
 select id into r from public.duty_swap_requests where month='2099-11' and status='awaiting_engineer' and requester_id=a_id;
 reset role;
 insert into public.duty_publications(month,version,published_by) values('2099-11',5,admin_id) returning id into pub;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 select pub,day,end_day,case when day='2099-11-03' then c_id else primary_id end from public.duty_assignments where publication_id=newer;
 update public.duty_months set current_publication_id=pub,publication_sequence=5 where month='2099-11';
 if not exists(select 1 from public.duty_swap_requests where id=r and requester_id=a_id and status='invalidated') then raise exception 'Requester changed instead of invalidation'; end if;
 -- Unpublishing safely invalidates remaining requests, without touching history.
 perform set_config('request.jwt.claim.sub',c_id::text,true); set local role authenticated;
 select id into x from public.duty_assignments where publication_id=pub and day='2099-11-03';
 select id into y from public.duty_assignments where publication_id=pub and day='2099-11-04';
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(x,y,'Unpublish',rev);
 select id into r from public.duty_swap_requests where month='2099-11' and status='awaiting_engineer' and requester_id=c_id;
 reset role; update public.duty_months set current_publication_id=null where month='2099-11';
 if (select status from public.duty_swap_requests where id=r)<>'invalidated' then raise exception 'Unpublished request still pending'; end if;
 -- Simulate a pending request aging past its date without a pointer change.
 -- Resolution must commit invalidation and return it, never a false approval.
 update public.duty_months set current_publication_id=pub where month='2099-11';
 insert into public.duty_swap_requests(month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
 values('2099-11',pub,c_id,b_id,'2000-01-01','2000-01-02','2000-01-03','2000-01-04') returning id into r;
 perform set_config('request.jwt.claim.sub',c_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 if public.duty_resolve_swap(r,'cancel',rev)<>'invalidated' then raise exception 'Invalidation not reported'; end if;
 if (select status from public.duty_swap_requests where id=r)<>'invalidated' then raise exception 'Invalidation rolled back'; end if;
 if (select revision from public.duty_workspace)<>rev+1 then raise exception 'Invalidation did not advance revision'; end if;
end $$;
-- Admin-proposed swaps: both members accept, then an explicit admin approval.
reset role;
create function pg_temp.slot(p_day date) returns uuid language sql as $$
 select a.id from public.duty_assignments a join public.duty_months m on m.current_publication_id=a.publication_id
 where m.month='2098-03' and a.day=p_day$$;
create function pg_temp.act(p_user uuid) returns bigint language plpgsql as $$
begin perform set_config('request.jwt.claim.sub',p_user::text,true); return (select revision from public.duty_workspace); end $$;
create function pg_temp.republish(p_owners jsonb,p_by uuid) returns void language plpgsql as $$
declare old uuid; live uuid;
begin
 select current_publication_id into old from public.duty_months where month='2098-03';
 update public.duty_months set publication_sequence=publication_sequence+1 where month='2098-03';
 insert into public.duty_publications(month,version,published_by) select month,publication_sequence,p_by from public.duty_months where month='2098-03' returning id into live;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,extra_points)
 select live,day,end_day,coalesce((p_owners->>day::text)::uuid,primary_id),secondary_id,extra_points from public.duty_assignments where publication_id=old;
 update public.duty_months set current_publication_id=live where month='2098-03';
end $$;
do $$
declare
 boss uuid:=gen_random_uuid(); x uuid:=gen_random_uuid(); y uuid:=gen_random_uuid(); z uuid:=gen_random_uuid();
 tamar uuid:=gen_random_uuid(); noa uuid:=gen_random_uuid();
 pub uuid; live uuid; req uuid; rev bigint; history jsonb; result jsonb; extra numeric; net jsonb;
begin
 delete from public.duty_constraints;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
 select id,id||'@example.invalid',now(),false,'authenticated','authenticated' from unnest(array[boss,x,y,z]) id;
 insert into public.duty_members(id,email,name,role,status,active)
 values(boss,boss||'@example.invalid','Proposing admin','admin','approved',true),(x,x||'@example.invalid','Xavi','engineer','approved',true),
 (y,y||'@example.invalid','Yael','engineer','approved',true),(z,z||'@example.invalid','Zohar','engineer','approved',true);
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2098-03','2098-02-25','published',1);
 insert into public.duty_publications(month,version,published_by) values('2098-03',1,boss) returning id into pub;
 update public.duty_months set current_publication_id=pub where month='2098-03';
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 values(pub,'2098-03-02','2098-03-03',x),(pub,'2098-03-03','2098-03-04',y),(pub,'2098-03-04','2098-03-05',z),(pub,'2098-03-05','2098-03-06',boss);
 select jsonb_agg(to_jsonb(a) order by day) into history from public.duty_assignments a where publication_id=pub;

 -- Only admins propose for others; engineers cannot pass someone else's duty first.
 rev:=pg_temp.act(z); set local role authenticated;
 begin perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev); raise exception 'Engineer proposed for others'; exception when insufficient_privilege then null; end;
 begin perform public.duty_request_swap(pg_temp.slot('2098-03-03'),pg_temp.slot('2098-03-04'),'',rev); raise exception 'Engineer passed counterpart duty first'; exception when insufficient_privilege then null; end;
 -- Availability check: parties and admins only, who and which date, never the note.
 begin perform public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03')); raise exception 'Outsider read availability'; exception when insufficient_privilege then null; end;
 reset role; insert into public.duty_constraints values(y,'2098-03-02','no','Secret availability note'),(x,'2098-03-09','no','Unrelated');
 rev:=pg_temp.act(x); set local role authenticated;
 result:=public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'));
 if result<>jsonb_build_array(jsonb_build_object('member',y,'day','2098-03-02')) then raise exception 'Party availability wrong: %',result; end if;
 rev:=pg_temp.act(boss);
 if public.duty_swap_availability(pg_temp.slot('2098-03-03'),pg_temp.slot('2098-03-02'))::text like '%Secret%'
  or public.duty_swap_availability(pg_temp.slot('2098-03-03'),pg_temp.slot('2098-03-02'))<>result then raise exception 'Admin availability wrong'; end if;
 -- Emergency cover is named to admins only; members get past pairs refused.
 reset role; update public.duty_assignments set secondary_id=z where publication_id=pub and day='2098-03-03';
 insert into public.duty_constraints values(z,'2098-03-03','no','Cover note');
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,'2000-01-03','2000-01-04',y);
 set local role authenticated;
 if public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'))->1<>jsonb_build_object('member',z,'day','2098-03-03') then raise exception 'Admin cannot see cover conflict'; end if;
 perform pg_temp.act(x);
 if public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'))<>result||jsonb_build_array(jsonb_build_object('member',null,'day','2098-03-03'))
  or public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'))::text like '%'||z||'%' then raise exception 'Cover identity leaked to a member'; end if;
 perform pg_temp.act(y);
 begin perform public.duty_swap_availability(pg_temp.slot('2000-01-03'),pg_temp.slot('2098-03-02')); raise exception 'Member read a past pair';
 exception when raise_exception then if sqlerrm<>'Choose duties starting today or later' then raise; end if; end;
 reset role; update public.duty_assignments set secondary_id=null where publication_id=pub and day='2098-03-03';
 delete from public.duty_assignments where publication_id=pub and day='2000-01-03'; delete from public.duty_constraints where member_id=z;
 rev:=pg_temp.act(boss); set local role authenticated;
 if public.duty_swap_availability(pg_temp.slot('2098-03-04'),pg_temp.slot('2098-03-05'))<>'[]'::jsonb then raise exception 'Unrelated conflict reported'; end if;
 begin perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev); raise exception 'Unavailable proposal sent';
 exception when raise_exception then if sqlerrm<>'Availability conflict. An admin must explicitly override with a reason.' then raise; end if; end;
 reset role; set local role anon;
 begin perform public.duty_swap_availability(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03')); raise exception 'Anon read availability'; exception when insufficient_privilege then null; end;
 reset role; delete from public.duty_constraints;

 -- Proposal: nothing changes; proposer, both parties see it; outsiders do not.
 rev:=pg_temp.act(boss); set local role authenticated;
 perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'Admin proposal',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 if not exists(select 1 from public.duty_swap_requests where id=req and requester_id=x and other_id=y and proposed_by=boss and requester_accepted_at is null and accepted_by is null)
  then raise exception 'Proposal not recorded for both parties'; end if;
 foreach live in array array[x,y] loop
  perform pg_temp.act(live);
  if not exists(select 1 from public.duty_swap_requests where id=req) then raise exception 'Party cannot see proposal'; end if;
 end loop;
 rev:=pg_temp.act(z);
 if exists(select 1 from public.duty_swap_requests where id=req) then raise exception 'Outsider sees proposal'; end if;
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Outsider accepted'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(x);
 begin perform public.duty_resolve_swap(req,'cancel',rev); raise exception 'Party cancelled admin proposal'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Proposer consented for a party'; exception when insufficient_privilege then null; end;
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Approved before consent';
 exception when raise_exception then if sqlerrm<>'Both engineers must accept before admin review' then raise; end if; end;
 -- One side accepts: still waiting for the other. Double accept and late decline fail.
 rev:=pg_temp.act(y); perform public.duty_resolve_swap(req,'accept',rev);
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_engineer' and accepted_by=y and requester_accepted_at is null) then raise exception 'Counterpart consent not recorded'; end if;
 rev:=pg_temp.act(y);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Double accept allowed'; exception when raise_exception then if sqlerrm<>'Your answer is already recorded' then raise; end if; end;
 begin perform public.duty_resolve_swap(req,'decline',rev); raise exception 'Decline after accept allowed'; exception when raise_exception then if sqlerrm<>'Your answer is already recorded' then raise; end if; end;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Approved with one consent';
 exception when raise_exception then if sqlerrm<>'Both engineers must accept before admin review' then raise; end if; end;
 rev:=pg_temp.act(x); perform public.duty_resolve_swap(req,'accept',rev);
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_admin' and requester_accepted_at is not null) then raise exception 'Both consents did not reach admin review'; end if;
 rev:=pg_temp.act(x);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Requester double accept allowed'; exception when raise_exception then if sqlerrm<>'Engineer consent already recorded' then raise; end if; end;
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Party approved own swap'; exception when insufficient_privilege then null; end;
 reset role;
 if (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id=(select current_publication_id from public.duty_months where month='2098-03'))<>history
  then raise exception 'Assignments changed before final approval'; end if;
 -- A conflict added after consent still needs the audited admin override.
 insert into public.duty_constraints values(x,'2098-03-03','no','Late private note');
 rev:=pg_temp.act(boss); set local role authenticated;
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Late conflict approved without reason';
 exception when raise_exception then if sqlerrm<>'Availability conflict. An admin must explicitly override with a reason.' then raise; end if; end;
 perform public.duty_resolve_swap(req,'approve',rev,'Recorded in the external system');
 select current_publication_id into live from public.duty_months where month='2098-03';
 if live=pub or (select primary_id from public.duty_assignments where publication_id=live and day='2098-03-02')<>y
  or (select primary_id from public.duty_assignments where publication_id=live and day='2098-03-03')<>x then raise exception 'Admin-proposed swap not published'; end if;
 if not exists(select 1 from public.duty_swap_requests where id=req and status='approved' and resolved_by=boss and override_reason='Recorded in the external system') then raise exception 'Approval not audited'; end if;
 reset role;
 if (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id=pub)<>history then raise exception 'Published history changed'; end if;
 delete from public.duty_constraints;
 rev:=pg_temp.act(boss); set local role authenticated;
 if not exists(select 1 from public.duty_swap_requests where id=req) then raise exception 'Proposer lost resolved history'; end if;

 -- Admin as a party: either order normalizes to the admin's side; only the other member is asked.
 perform public.duty_request_swap(pg_temp.slot('2098-03-04'),pg_temp.slot('2098-03-05'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 if not exists(select 1 from public.duty_swap_requests where id=req and requester_id=boss and other_id=z and proposed_by is null and from_day='2098-03-05')
  then raise exception 'Admin party not normalized to requester'; end if;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Admin party answered twice'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(z); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(z);
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Engineer party approved'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(boss);
 if (select status from public.duty_swap_requests where id=req)<>'awaiting_admin' then raise exception 'Admin party swap skipped final approval'; end if;
 perform public.duty_resolve_swap(req,'approve',rev);
 if (select status from public.duty_swap_requests where id=req)<>'approved' then raise exception 'Admin party approval failed'; end if;

 -- Reject, cancel and decline at the consent stage, including an engineer's own request.
 rev:=pg_temp.act(z); perform public.duty_request_swap(pg_temp.slot('2098-03-05'),pg_temp.slot('2098-03-02'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'reject',rev);
 if (select status from public.duty_swap_requests where id=req)<>'rejected' then raise exception 'Early reject of engineer request failed'; end if;
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'reject',rev);
 if (select status from public.duty_swap_requests where id=req)<>'rejected' then raise exception 'Early reject failed'; end if;
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(x); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'cancel',rev);
 if (select status from public.duty_swap_requests where id=req)<>'cancelled' then raise exception 'Proposer cancel failed'; end if;
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(y); perform public.duty_resolve_swap(req,'decline',rev);
 if (select status from public.duty_swap_requests where id=req)<>'declined' then raise exception 'Requester-side decline failed'; end if;

 -- A reassigned counterpart is a new pairing: both members answer again.
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(y); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(x); perform public.duty_resolve_swap(req,'accept',rev);
 reset role;
 select current_publication_id into pub from public.duty_months where month='2098-03';
 update public.duty_months set publication_sequence=publication_sequence+1 where month='2098-03';
 insert into public.duty_publications(month,version,published_by) select month,publication_sequence,boss from public.duty_months where month='2098-03' returning id into live;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 select live,day,end_day,case when day='2098-03-03' then boss else primary_id end from public.duty_assignments where publication_id=pub;
 update public.duty_months set current_publication_id=live where month='2098-03';
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_engineer' and other_id=boss and accepted_by is null and requester_accepted_at is null)
  then raise exception 'Reassigned counterpart did not reset consent'; end if;
 if exists(select 1 from public.duty_swap_requests where id=req and requester_accepted_at is not null) then raise exception 'Requester consent survived a new counterpart'; end if;
 set local role authenticated; rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'reject',rev);

 -- Consent covers the points moved: republishing the same points keeps the answers,
 -- different points void them instead of approving a swap nobody agreed to.
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-05'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(y); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(z); perform public.duty_resolve_swap(req,'accept',rev);
 reset role;
 foreach extra in array array[0,1] loop
  select current_publication_id into pub from public.duty_months where month='2098-03';
  update public.duty_months set publication_sequence=publication_sequence+1 where month='2098-03';
  insert into public.duty_publications(month,version,published_by) select month,publication_sequence,boss from public.duty_months where month='2098-03' returning id into live;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,extra_points)
  select live,day,end_day,primary_id,case when day='2098-03-05' then extra else extra_points end from public.duty_assignments where publication_id=pub;
  update public.duty_months set current_publication_id=live where month='2098-03';
  if extra=0 and (select status from public.duty_swap_requests where id=req)<>'awaiting_admin' then raise exception 'Unchanged republish voided consent'; end if;
 end loop;
 if (select status from public.duty_swap_requests where id=req)<>'invalidated' then raise exception 'Changed points kept the old consent'; end if;
 set local role authenticated; rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Invalidated swap approved';
 exception when raise_exception then if sqlerrm<>'This request is no longer pending' then raise; end if; end;

 -- A weighted swap moves the point difference into the ledger once; a stale tab
 -- cannot approve it, and swapping back returns both members to where they were.
 reset role; perform pg_temp.act(boss); net:=duty_private.balance()->'net';
 set local role authenticated;
 foreach live in array array[y,z] loop
  rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-05'),'',rev);
  select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
  rev:=pg_temp.act(y); perform public.duty_resolve_swap(req,'accept',rev);
  rev:=pg_temp.act(z); perform public.duty_resolve_swap(req,'accept',rev);
  rev:=pg_temp.act(boss);
  begin perform public.duty_resolve_swap(req,'approve',rev-1); raise exception 'Stale tab approved';
  exception when serialization_failure then if sqlerrm<>'The team data changed. Refresh and try again.' then raise; end if; end;
  perform public.duty_resolve_swap(req,'approve',rev);
  reset role; perform pg_temp.act(boss);
  if live=y and ((duty_private.balance()->'net'->>y::text)::numeric<>(net->>y::text)::numeric+2
   or (duty_private.balance()->'net'->>z::text)::numeric<>(net->>z::text)::numeric-2) then raise exception 'Weighted swap did not move one point once: %',duty_private.balance()->'net'; end if;
  if live=z and duty_private.balance()->'net'<>net then raise exception 'Swap back left a balance: %',duty_private.balance()->'net'; end if;
  set local role authenticated;
 end loop;

 -- Temporary members have no account: an admin answers their open side, and only
 -- theirs; the explicit final approval stays a separate step (decision 2026-11-01).
 reset role;
 insert into public.duty_members(id,name,role,status,active,is_temporary)
 values(tamar,'Tamar','engineer','approved',true,true),(noa,'Noa','engineer','approved',true,true);
 perform pg_temp.republish(jsonb_build_object('2098-03-03',tamar,'2098-03-04',noa),boss);
 set local role authenticated;
 -- An engineer asks a temporary member (before, nobody could ever answer it).
 rev:=pg_temp.act(y); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-03'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(x);
 if exists(select 1 from public.duty_swap_requests where id=req) then raise exception 'Outsider sees a request waiting on a temporary member'; end if;
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Engineer answered for a temporary member'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(boss);
 if not exists(select 1 from public.duty_swap_requests where id=req) then raise exception 'Admin cannot see a request waiting on a temporary member'; end if;
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Approved before the temporary member answered';
 exception when raise_exception then if sqlerrm<>'Both engineers must accept before admin review' then raise; end if; end;
 perform public.duty_resolve_swap(req,'accept',rev);
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_admin' and accepted_by=tamar and resolved_by is null)
  then raise exception 'Admin answer not recorded as the temporary member''s consent'; end if;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Admin answered twice';
 exception when raise_exception then if sqlerrm<>'Engineer consent already recorded' then raise; end if; end;
 perform public.duty_resolve_swap(req,'approve',rev);
 if (select primary_id from public.duty_assignments where id=pg_temp.slot('2098-03-03'))<>y
  or (select primary_id from public.duty_assignments where id=pg_temp.slot('2098-03-02'))<>tamar then raise exception 'Temporary swap not published'; end if;
 -- Only for temporary members: the admin answers Tamar's side, never Zohar's.
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-05'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 if not exists(select 1 from public.duty_swap_requests where id=req and requester_id=tamar and other_id=z and proposed_by=boss) then raise exception 'Proposal with a temporary member not recorded'; end if;
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'accept',rev);
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_engineer' and requester_accepted_at is not null and accepted_by is null)
  then raise exception 'Admin did not answer the temporary requester'; end if;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'accept',rev); raise exception 'Admin answered for a regular member'; exception when insufficient_privilege then null; end;
 rev:=pg_temp.act(z); perform public.duty_resolve_swap(req,'decline',rev);
 -- Both parties temporary: the admin answers both sides, then still approves explicitly.
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-04'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'accept',rev);
 if not exists(select 1 from public.duty_swap_requests where id=req and status='awaiting_admin' and requester_accepted_at is not null and accepted_by=noa)
  then raise exception 'Admin did not answer both temporary sides'; end if;
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(req,'approve',rev);
 if (select status from public.duty_swap_requests where id=req)<>'approved' then raise exception 'Temporary swap not approved'; end if;

 -- Nobody waits on a member who can no longer sign in: deactivating a party
 -- invalidates their pending swaps at either step (owners now: 03-02 Noa,
 -- 03-03 Yael, 03-04 Tamar, 03-05 Zohar).
 rev:=pg_temp.act(y); perform public.duty_request_swap(pg_temp.slot('2098-03-03'),pg_temp.slot('2098-03-05'),'',rev);
 select id into req from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 rev:=pg_temp.act(z); perform public.duty_resolve_swap(req,'accept',rev);
 rev:=pg_temp.act(boss); perform public.duty_request_swap(pg_temp.slot('2098-03-02'),pg_temp.slot('2098-03-04'),'',rev);
 select id into live from public.duty_swap_requests where month='2098-03' and status='awaiting_engineer';
 reset role; update public.duty_members set active=false where id in (y,noa);
 if exists(select 1 from public.duty_swap_requests where id in (req,live) and status<>'invalidated') then raise exception 'A request kept waiting on an inactive member'; end if;
 set local role authenticated;
 rev:=pg_temp.act(boss);
 begin perform public.duty_resolve_swap(req,'approve',rev); raise exception 'Swap with an inactive party approved';
 exception when raise_exception then if sqlerrm<>'This request is no longer pending' then raise; end if; end;
end $$;
select 'PASS: admin-proposed swaps need both members and an explicit admin approval; admin parties are asked once; availability names who and when, never the note; consent covers counterpart and points; weighted swaps and swap-backs post once; admins answer for temporary members only; deactivation never leaves a swap waiting' as result;
rollback;
\ir swap-today.sql

-- Run only on an empty local/development database. All synthetic data rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare
 admin_id uuid:=gen_random_uuid(); engineer_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); cover_id uuid:=gen_random_uuid(); pending_id uuid:=gen_random_uuid();
 pub uuid; new_pub uuid; from_id uuid; to_id uuid; weekend_id uuid; split_id uuid; request_id uuid; competing uuid; rev bigint; before_rows jsonb; draft_rows jsonb;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Run fixtures in an empty development project'; end if;
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
 if exists(select 1 from public.duty_swap_requests) then raise exception 'Other engineer sees explanation'; end if;
 begin perform public.duty_resolve_swap(request_id,'cancel',rev+1); raise exception 'Other engineer can cancel'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true);
 perform public.duty_resolve_swap(request_id,'cancel',rev+1);
 if (select status from public.duty_swap_requests where id=request_id)<>'cancelled' then raise exception 'Cancel failed'; end if;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_resolve_swap(request_id,'cancel',rev); raise exception 'Double cancellation allowed'; exception when raise_exception then if sqlerrm='Double cancellation allowed' then raise; end if; end;
 perform public.duty_request_swap(from_id,to_id,'Reject me',rev);
 select id into request_id from public.duty_swap_requests where status='pending';
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_resolve_swap(request_id,'reject',rev);
 if (select status from public.duty_swap_requests where id=request_id)<>'rejected' then raise exception 'Rejection failed'; end if;
 reset role;
 if before_rows is distinct from (select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id=pub) then raise exception 'Request/cancel/reject mutated publication'; end if;

 -- Request-time unavailability is checked without exposing private notes.
 insert into public.duty_constraints values(engineer_id,'2099-10-06','no','Private');
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_request_swap(from_id,to_id,'',rev); raise exception 'Unavailable request accepted'; exception when raise_exception then if sqlerrm='Unavailable request accepted' then raise; end if; end;
 reset role; delete from public.duty_constraints;
 set local role authenticated; perform public.duty_request_swap(from_id,to_id,'Approve me',rev);
 select id into request_id from public.duty_swap_requests where status='pending';
 -- Another pending request will become stale when this publication is superseded.
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 select revision into rev from public.duty_workspace; perform public.duty_request_swap(to_id,from_id,'Concurrent source version',rev);
 select id into competing from public.duty_swap_requests where status='pending';
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
 perform public.duty_resolve_swap(competing,'reject',rev);
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
 select id into req from public.duty_swap_requests where status='pending' and month='2099-07';
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
 select id into req from public.duty_swap_requests where status='pending' and requester_id=auth.uid();
 perform set_config('request.jwt.claim.sub',admin_id::text,true); perform public.duty_resolve_swap(req,'approve',rev+1);
 select current_publication_id into result from public.duty_months where month='2099-07';
 if (select count(*) from public.duty_assignments where publication_id=result and end_day=day+1 and points=0.5)<>2 then raise exception 'Split weekend recombined or points changed'; end if;
 reset role;
 -- Both today and yesterday are excluded in Israel, even with otherwise valid duties.
 current_month:=to_char(today,'YYYY-MM');
 insert into public.duty_months(month,deadline,publication_sequence) values(current_month,today,1);
 insert into public.duty_publications(month,version,published_by) values(current_month,1,admin_id) returning id into pub;
 update public.duty_months set current_publication_id=pub where month=current_month;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,today,today+1,engineer_id) returning id into a;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values(pub,today+2,today+3,other_id) returning id into b;
 perform set_config('request.jwt.claim.sub',engineer_id::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 begin perform public.duty_request_swap(a,b,'',rev); raise exception 'Today accepted'; exception when raise_exception then if sqlerrm='Today accepted' then raise; end if; end;
 reset role; update public.duty_assignments set day=today-1,end_day=today where id=a;
 set local role authenticated;
 begin perform public.duty_request_swap(a,b,'',rev); raise exception 'Past duty accepted'; exception when raise_exception then if sqlerrm='Past duty accepted' then raise; end if; end;
end $$;
rollback;

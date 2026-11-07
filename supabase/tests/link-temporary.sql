-- Link a pending sign-up to a temporary member (decision 2026-11-07).
-- Synthetic fixtures only, on an empty disposable LOCAL database. Always rolls back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command; exception when others then
  if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;
 end;raise exception 'Unexpected acceptance: %',command;
end$$;
create function pg_temp.act(p_user uuid) returns bigint language plpgsql as $$
begin perform set_config('request.jwt.claim.sub',p_user::text,true); return (select revision from public.duty_workspace); end $$;
create function pg_temp.slot(p_day date) returns uuid language sql as $$
 select a.id from public.duty_assignments a join public.duty_months m on m.current_publication_id=a.publication_id where a.day=p_day $$;
do $$
declare
 boss uuid:='75000000-0000-0000-0000-000000000001'; eng uuid:='75000000-0000-0000-0000-000000000002';
 eng2 uuid:='75000000-0000-0000-0000-000000000003'; dana uuid:='75000000-0000-0000-0000-000000000004';
 omer uuid:='75000000-0000-0000-0000-000000000005'; gal uuid:='75000000-0000-0000-0000-000000000006'; noa uuid:='75000000-0000-0000-0000-000000000007';
 temp uuid; idle uuid; spare uuid; pub uuid; rev bigint; answered uuid; waiting uuid; before public.duty_members; after public.duty_members;
 duties integer;
begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL'; end if;
 if has_function_privilege('anon','public.duty_link_temporary_member(uuid,uuid,bigint)','EXECUTE')
  or has_function_privilege('anon','duty_private.link_temporary_member(uuid,uuid,bigint)','EXECUTE')
  or has_function_privilege('anon','duty_private.current_member_id()','EXECUTE') then raise exception 'Link exposed to anon'; end if;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
 select id,'link-'||right(id::text,1)||'@example.invalid',now(),false,'authenticated','authenticated' from unnest(array[boss,eng,eng2,dana,omer,gal,noa]) id;
 insert into public.duty_members(id,email,name,role,status,active,language)
 select id,'link-'||right(id::text,1)||'@example.invalid',n,r,s,s='approved',l from (values
  (boss,'Boss','admin','approved',null),(eng,'Eli','engineer','approved',null),(eng2,'Yael','engineer','approved',null),
  (dana,'Dana Levi','engineer','pending','he'),(omer,'Omer','engineer','pending',null),(gal,'Gal','engineer','pending',null),(noa,'Noa','engineer','pending',null)) v(id,n,r,s,l);

 -- Two temporary members with history: Dana (active, No weekends, a private note) and an inactive one.
 set local role authenticated;
 rev:=pg_temp.act(boss); temp:=public.duty_add_temporary_member('Dana',rev);
 rev:=pg_temp.act(boss); idle:=public.duty_add_temporary_member('Idle',rev);
 rev:=pg_temp.act(boss); perform public.duty_set_no_weekends(temp,true,rev);
 rev:=pg_temp.act(boss); perform public.duty_set_constraints(temp,array['2099-11-03'::date],'no','Private temporary note',rev);
 reset role;
 update public.duty_members set active=false where id=idle;
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2099-10','2099-09-25','draft',1);
 insert into public.duty_publications(month,version,published_by) values('2099-10',1,boss) returning id into pub;
 update public.duty_months set current_publication_id=pub where month='2099-10';
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) values
  (pub,'2099-10-05','2099-10-06',eng),(pub,'2099-10-06','2099-10-07',temp),(pub,'2099-10-07','2099-10-08',temp),(pub,'2099-10-08','2099-10-09',eng2);
 select count(*) into duties from public.duty_assignments where temp in (primary_id,secondary_id);
 -- A pending sign-up may already hold settings (normally impossible); they must move, not vanish.
 insert into public.duty_notification_settings(member_id,swaps) values(dana,false);
 set local role authenticated;
 -- One swap the admin already answered for Dana, one still waiting on her answer.
 rev:=pg_temp.act(eng2); perform public.duty_request_swap(pg_temp.slot('2099-10-08'),pg_temp.slot('2099-10-07'),'',rev);
 select id into answered from public.duty_swap_requests where requester_id=eng2;
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(answered,'accept',rev);
 rev:=pg_temp.act(eng); perform public.duty_request_swap(pg_temp.slot('2099-10-05'),pg_temp.slot('2099-10-06'),'',rev);
 select id into waiting from public.duty_swap_requests where requester_id=eng;
 select * into before from public.duty_members where id=temp;

 -- Only admins link, through the checked RPC, with a current revision.
 perform pg_temp.act(eng);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',dana,temp,pg_temp.act(eng)),'Admin access required');
 -- A pending sign-up can never claim a temporary member itself.
 perform pg_temp.act(dana);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,0)',dana,temp),'Admin access required');
 perform pg_temp.must_fail(format('update public.duty_members set linked_user_id=%L where id=%L',dana,temp),'permission denied');
 rev:=pg_temp.act(boss);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',dana,temp,rev-1),'team data changed');
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',dana,eng,rev),'Temporary member required');
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',eng,temp,rev),'no longer pending');
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',idle,temp,rev),'no longer pending');
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',gen_random_uuid(),temp,rev),'no longer pending');
 if (select revision from public.duty_workspace)<>rev then raise exception 'A refused link changed the revision'; end if;
 -- Before the link the sign-up sees only its own pending row.
 perform pg_temp.act(dana);
 if (select count(*) from public.duty_members)<>1 or duty_private.current_member_id() is distinct from dana then raise exception 'Pending sign-up identity wrong'; end if;

 -- The link: one person, the temporary member's id, history untouched.
 rev:=pg_temp.act(boss); perform public.duty_link_temporary_member(dana,temp,rev);
 if (select revision from public.duty_workspace)<>rev+1 then raise exception 'Link did not take one revision'; end if;
 reset role;
 select * into after from public.duty_members where id=temp;
 if exists(select 1 from public.duty_members where id=dana) then raise exception 'Pending sign-up row kept'; end if;
 if after.is_temporary or after.linked_user_id is distinct from dana or after.auth_user_id is distinct from dana
  or after.email<>'link-4@example.invalid' or after.language is distinct from 'he' or after.role<>'engineer' or after.status<>'approved'
  or after.name<>'Dana' or after.color<>before.color or not after.no_weekends or after.seniority<>before.seniority or not after.active
 then raise exception 'Linked member not merged: %',to_jsonb(after); end if;
 if (select count(*) from public.duty_assignments where temp in (primary_id,secondary_id))<>duties then raise exception 'Duties moved'; end if;
 if not exists(select 1 from public.duty_notification_settings where member_id=temp and not swaps) then raise exception 'Settings did not move'; end if;
 -- The swap the admin already answered stays as it was.
 if not exists(select 1 from public.duty_swap_requests where id=answered and status='awaiting_admin' and accepted_by=temp) then raise exception 'Answered swap changed'; end if;
 if (select status from public.duty_swap_requests where id=waiting)<>'awaiting_engineer' then raise exception 'Waiting swap changed'; end if;

 -- Signing in sees the merged member: their duties, private note and the waiting swap.
 set local role authenticated;
 perform pg_temp.act(dana);
 if not duty_private.is_member() or duty_private.current_member_id() is distinct from temp then raise exception 'Linked sign-in has no member access'; end if;
 if not exists(select 1 from public.duty_constraints where member_id=temp and note='Private temporary note') then raise exception 'Linked member cannot read their own note'; end if;
 if not exists(select 1 from public.duty_swap_requests where id=waiting) then raise exception 'Linked member cannot see the swap waiting on them'; end if;
 if (select count(*) from jsonb_array_elements(public.duty_load()->'members') m where m->>'id'=temp::text and m->>'auth_user_id'=dana::text)<>1 then raise exception 'Load missing the merged member'; end if;
 if (select (public.duty_notification_settings()->>'swaps')::boolean) then raise exception 'Linked member reads the wrong settings'; end if;
 -- Joining again never makes a second row.
 perform public.duty_join('Dana again');
 rev:=pg_temp.act(dana); perform public.duty_rename_self('Dana L.',rev);
 rev:=pg_temp.act(dana); perform public.duty_set_constraints(temp,array['2099-11-04'::date],'prefer','Mine',rev);
 reset role;
 if (select count(*) from public.duty_members where auth_user_id=dana)<>1 or (select name from public.duty_members where id=temp)<>'Dana L.'
  or not exists(select 1 from public.duty_constraints where member_id=temp and day='2099-11-04') then raise exception 'Own-row writes did not reach the merged member'; end if;
 set local role authenticated;

 -- The waiting swap is now answered by Dana only, never by the admin.
 rev:=pg_temp.act(boss);
 if exists(select 1 from public.duty_swap_requests where id=waiting) then raise exception 'Admin still sees a swap waiting on a real member'; end if;
 perform pg_temp.must_fail(format('select public.duty_resolve_swap(%L,''accept'',%s)',waiting,rev),'Only the current counterpart');
 rev:=pg_temp.act(dana); perform public.duty_resolve_swap(waiting,'accept',rev);
 reset role;
 if not exists(select 1 from public.duty_swap_requests where id=waiting and status='awaiting_admin' and accepted_by=temp) then raise exception 'Linked member answer not recorded'; end if;
 set local role authenticated;
 rev:=pg_temp.act(boss); perform public.duty_resolve_swap(waiting,'approve',rev);
 if (select primary_id from public.duty_assignments where id=pg_temp.slot('2099-10-05'))<>temp
  or (select published_by from public.duty_publications p join public.duty_months m on m.current_publication_id=p.id where m.month='2099-10')<>boss
 then raise exception 'Swap with the linked member not published'; end if;

 -- Promoted to admin, the linked member publishes under their member id (published_by and
 -- resolved_by reference member rows, never the sign-in id).
 rev:=pg_temp.act(boss); perform public.duty_set_role(temp,'admin',rev);
 rev:=pg_temp.act(eng); perform public.duty_request_swap(pg_temp.slot('2099-10-06'),pg_temp.slot('2099-10-05'),'',rev);
 select id into waiting from public.duty_swap_requests where requester_id=eng and status='awaiting_engineer';
 rev:=pg_temp.act(dana); perform public.duty_resolve_swap(waiting,'accept',rev);
 rev:=pg_temp.act(dana); perform public.duty_resolve_swap(waiting,'approve',rev);
 reset role;
 if (select published_by from public.duty_publications p join public.duty_months m on m.current_publication_id=p.id where m.month='2099-10')<>temp
  or (select resolved_by from public.duty_swap_requests where id=waiting)<>temp then raise exception 'Linked admin not recorded by member id'; end if;
 set local role authenticated;
 rev:=pg_temp.act(boss); perform public.duty_set_role(temp,'engineer',rev);

 -- Linking cannot be repeated or undone, and a linked member is no longer a target.
 rev:=pg_temp.act(boss);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',dana,temp,rev),'no longer pending');
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',omer,temp,rev),'Temporary member required');

 -- An inactive temporary member stays inactive: the sign-up waits like any inactive member.
 rev:=pg_temp.act(boss); perform public.duty_link_temporary_member(omer,idle,rev);
 perform pg_temp.act(omer);
 if duty_private.is_member() or (select count(*) from public.duty_members)<>1 or (select active from public.duty_members where id=idle) then raise exception 'Inactive link wrong'; end if;
 perform public.duty_join('Omer');
 reset role;
 if exists(select 1 from public.duty_members where id=omer) then raise exception 'Inactive linked sign-up joined again'; end if;
 set local role authenticated;

 -- The ledger has no foreign keys: a sign-up an admin recorded a debt for is never linked
 -- (the debt would stay on a deleted id).
 rev:=pg_temp.act(boss); perform public.duty_compensation(jsonb_build_object('kind','claim','debtorId',noa,'creditorId',eng,'units',1),'link-claim','Synthetic',rev);
 rev:=pg_temp.act(boss);
 spare:=public.duty_add_temporary_member('Spare',rev);
 rev:=pg_temp.act(boss);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',noa,spare,rev),'link-has-balance');

 -- Decline still works.
 rev:=pg_temp.act(boss); perform public.duty_review_member(gal,'rejected',rev);
 if (select status from public.duty_members where id=gal)<>'rejected' then raise exception 'Decline broken'; end if;
 rev:=pg_temp.act(boss);
 perform pg_temp.must_fail(format('select public.duty_link_temporary_member(%L,%L,%s)',gal,idle,rev),'no longer pending');
 reset role;
end $$;
rollback;
select 'PASS: only admins link a pending sign-up to a temporary member; the row keeps its id and history and gains the sign-in, email and language; the sign-in sees the merged data; swaps waiting on them move from the admin to the person; inactive stays inactive; Decline unchanged' as result;

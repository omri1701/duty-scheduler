-- Draft/publication lifecycle. Frozen migration history is unchanged.
-- Freeze checked writes while classifying existing working data. The CLI runs
-- this entire migration in one transaction; any refusal rolls everything back.
DO $$
declare m public.duty_months; working jsonb; published jsonb;
begin
 perform 1 from public.duty_workspace where id for update;
 if exists(select 1 from public.duty_assignments a where a.publication_id is null
  and not exists(select 1 from public.duty_months owning where owning.month=duty_private.duty_owner(a.day))) then
  raise exception 'Working duties have no owning month; review before lifecycle conversion';
 end if;
 for m in select * from public.duty_months where status='published' loop
  if m.current_publication_id is null then raise exception 'Published month % has no publication; review before lifecycle conversion',m.month; end if;
  -- IDs are deliberately excluded: old working copies have separate identities.
  select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) into working
  from public.duty_assignments a where a.publication_id is null and duty_private.duty_owner(a.day)=m.month;
  if working is null then continue; end if;
  select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) into published
  from public.duty_assignments a where a.publication_id=m.current_publication_id and duty_private.duty_owner(a.day)=m.month;
  -- A completed swap may have left stale working rows, but this is not proof
  -- they are disposable. Never guess that differing data is unpublished/stale.
  if working is distinct from published then
   raise exception 'Published month % has divergent working data; review before lifecycle conversion',m.month;
  end if;
 end loop;
 if exists(select 1 from public.duty_swap_requests request join public.duty_assignments working
  on working.id in (request.from_duty_id,request.to_duty_id)
  join public.duty_months owning on owning.month=duty_private.duty_owner(working.day)
  where working.publication_id is null and owning.status='published') then
  raise exception 'A request references working duties; review before lifecycle conversion';
 end if;
 delete from public.duty_assignments a where a.publication_id is null
 and exists(select 1 from public.duty_months owning where owning.month=duty_private.duty_owner(a.day) and owning.status='published');
 -- Invalidate every existing workspace snapshot, including reopened-only teams
 -- whose old save implementation may already be waiting on this lock.
 -- A fresh empty installation retains the required initial revision zero.
 if exists(select 1 from public.duty_members) or exists(select 1 from public.duty_months) then
  update public.duty_workspace set revision=revision+1 where id;
 end if;
end $$;

CREATE OR REPLACE FUNCTION duty_private.check_revision(p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare current_revision bigint;
begin
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select revision into current_revision from public.duty_workspace where id for update;
 -- Membership may have changed while waiting for the workspace lock.
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 if current_revision is distinct from p_revision then raise exception 'The team data changed. Refresh and try again.' using errcode='40001'; end if;
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE OR REPLACE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare x record; item jsonb; d date; a public.duty_assignments; m public.duty_months; first_day date; last_day date; publication uuid; next_version integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  -- Profile names and roles have separate checked operations.
  update public.duty_members set color=x.value->>'color',active=(x.value->>'active')::boolean,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown approved team member'; end if;
 end loop;
 perform duty_private.assert_admin_remains();
 for x in select * from jsonb_each(p_state->'months') loop
  select * into m from public.duty_months where month=x.key;
  if m.status='published' and (x.value->>'status'='draft' or p_publish=x.key) then raise exception 'Reopen the draft first'; end if;
  if x.value->>'status'='published' and coalesce(m.status,'draft')='draft' and p_publish is distinct from x.key then raise exception 'Use Publish to publish a draft'; end if;
  insert into public.duty_months(month,deadline,generated) values(x.key,(x.value->>'deadline')::date,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,generated=case when duty_months.status='published' then true else excluded.generated end;
 end loop;
 -- A scoped save cannot erase drafts omitted from the request or materialize a
 -- published schedule as working rows. Status transitions use checked operations.
 delete from public.duty_assignments working where working.publication_id is null
 and p_state->'months' ? duty_private.duty_owner(working.day)
 and exists(select 1 from public.duty_months owning where owning.month=duty_private.duty_owner(working.day) and owning.status='draft')
 and working.day not in (select (value->>'day')::date from jsonb_array_elements(p_state->'duties'));
 for item in select value from jsonb_array_elements(p_state->'duties') loop
  if not (p_state->'months' ? duty_private.duty_owner((item->>'day')::date)) or not exists(select 1 from public.duty_months where month=duty_private.duty_owner((item->>'day')::date) and status='draft') then raise exception 'Duty requires its owning month draft'; end if;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if p_publish is not null then
  if not (p_state->'months' ? p_publish) or not exists(select 1 from public.duty_months where month=p_publish and status='draft') then raise exception 'An open month draft is required'; end if;
  first_day:=(p_publish||'-01')::date; last_day:=(first_day+interval '1 month'-interval '1 day')::date;
  -- Validate only this month's owned dates, including its final Friday's Saturday.
  if extract(dow from first_day)=6 then first_day:=first_day+1; end if;
  if extract(dow from last_day)=5 then last_day:=last_day+1; end if;
  for d in select generate_series(first_day,last_day,interval '1 day')::date loop
   select * into a from public.duty_assignments where publication_id is null and day<=d and end_day>d;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints where member_id in (a.primary_id,a.secondary_id) and day=d and kind='no') then raise exception 'Availability conflict on %',d; end if;
  end loop;
  update public.duty_months set publication_sequence=publication_sequence+1 where month=p_publish returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(p_publish,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 -- Old versions may contain adjacent coverage. Only Friday-owned rows belong
 -- to this draft; retain the original historical publication byte-for-byte.
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=v.month;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points
 from public.duty_assignments where publication_id=p_publication and duty_private.duty_owner(day)=v.month;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into m from public.duty_months where month=p_month;
 if m.current_publication_id is null or m.status<>'draft' then raise exception 'A reopened published month is required'; end if;
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_month;
 update public.duty_months set status='published',generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications; replacement uuid;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select id into replacement from public.duty_publications where month=v.month and id<>v.id order by version desc limit 1;
 -- Deleting the final publication must not silently discard the only schedule.
 -- Keep an already-open draft, otherwise copy the version before deleting it.
 if replacement is null and exists(select 1 from public.duty_months where current_publication_id=v.id and status='published') then
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments
  where publication_id=v.id and duty_private.duty_owner(day)=v.month;
 end if;
 update public.duty_months set current_publication_id=replacement,status=case when replacement is null then 'draft' else status end where current_publication_id=v.id;
 delete from public.duty_publications where id=v.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d date; m text; manager boolean;
begin
 perform duty_private.check_revision(p_revision);
 manager:=duty_private.is_manager();
 if (not manager and p_member<>auth.uid()) or not exists(select 1 from public.duty_members where id=p_member and status='approved') then raise exception 'Not allowed' using errcode='42501'; end if;
 if p_kind not in ('no','prefer','clear') or p_kind is null or coalesce(cardinality(p_days),0) not between 1 and 62 or length(coalesce(p_note,''))>300 then raise exception 'Invalid constraints'; end if;
 foreach d in array p_days loop
  if d is null then raise exception 'Invalid date'; end if;
  m:=to_char(d,'YYYY-MM');
  insert into public.duty_months(month,deadline) values(m,date_trunc('month',d)::date-7) on conflict do nothing;
  if not manager and exists(select 1 from public.duty_months where month=m and (status='published' or deadline < (now() at time zone 'Asia/Jerusalem')::date)) then raise exception 'Constraints are closed for this month' using errcode='42501'; end if;
  if p_kind='clear' then delete from public.duty_constraints where member_id=p_member and day=d;
  else insert into public.duty_constraints(member_id,day,kind,note) values(p_member,d,p_kind,trim(coalesce(p_note,''))) on conflict(member_id,day) do update set kind=excluded.kind,note=excluded.note; end if;
  -- Availability is independent of the working schedule. In particular, an
  -- admin constraint edit must not create an empty draft of a published month.
 end loop;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 update public.duty_members set role=p_role where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 perform duty_private.assert_admin_remains();
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_status not in ('approved','rejected') or p_status is null then raise exception 'Invalid review'; end if;
 update public.duty_members set status=p_status,active=(p_status='approved'),seniority=(select coalesce(max(seniority),0)+1 from public.duty_members) where id=p_member and role='engineer' and status='pending';
 if not found then raise exception 'This request is no longer pending'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

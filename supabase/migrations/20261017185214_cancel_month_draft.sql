CREATE FUNCTION duty_private.cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months; d date; conflict record;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 select * into m from public.duty_months where month=p_month;
 if m.current_publication_id is null or m.status<>'draft' then raise exception 'A reopened published month is required'; end if;
 -- The pointer is read under the workspace revision lock, never supplied by a client.
 -- Saturday (including a special/split Saturday) belongs to its Friday's month.
 for d in select generate_series((p_month||'-01')::date, (p_month||'-01')::date+interval '1 month',interval '1 day')::date loop
  if duty_private.duty_owner(d)=p_month and (select count(*) from public.duty_assignments a where a.publication_id=m.current_publication_id and duty_private.duty_owner(a.day)=p_month and a.day<=d and a.end_day>d)<>1 then
   raise exception 'Published coverage is inconsistent on %; no changes were made',d;
  end if;
 end loop;
 select a.day,a.end_day,b.day as other_day,b.end_day as other_end into conflict
 from public.duty_assignments a join public.duty_assignments b on a.day<b.end_day and b.day<a.end_day
 where a.publication_id=m.current_publication_id and duty_private.duty_owner(a.day)=p_month
 and b.publication_id is null and duty_private.duty_owner(b.day)<>p_month limit 1;
 if found then raise exception 'Published duty [% - %) conflicts with another month duty [% - %); no changes were made',conflict.day,conflict.end_day,conflict.other_day,conflict.other_end; end if;
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_month;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments
 where publication_id=m.current_publication_id and duty_private.duty_owner(day)=p_month;
 update public.duty_months set status='published',generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
CREATE FUNCTION public.duty_cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.cancel_draft(p_month,p_revision)$$;
CREATE OR REPLACE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare x record; item jsonb; d date; a public.duty_assignments; first_day date; last_day date; publication uuid; next_version integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  -- Profile names and roles have separate checked operations.
  update public.duty_members set color=x.value->>'color',active=(x.value->>'active')::boolean,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown approved team member'; end if;
 end loop;
 perform duty_private.assert_admin_remains();
 for x in select * from jsonb_each(p_state->'months') loop
  insert into public.duty_months(month,deadline,status,generated) values(x.key,(x.value->>'deadline')::date,case when x.value->>'status'='published' and exists(select 1 from public.duty_months where month=x.key and current_publication_id is not null) then 'published' else 'draft' end,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,status=excluded.status,generated=excluded.generated;
 end loop;
 delete from public.duty_assignments where publication_id is null and day not in (select (value->>'day')::date from jsonb_array_elements(p_state->'duties'));
 for item in select value from jsonb_array_elements(p_state->'duties') loop
  if not exists(select 1 from public.duty_months where month=duty_private.duty_owner((item->>'day')::date)) then
   insert into public.duty_months(month,deadline) values(duty_private.duty_owner((item->>'day')::date),(duty_private.duty_owner((item->>'day')::date)||'-01')::date-7);
  end if;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if p_publish is not null then
  if not exists(select 1 from public.duty_months where month=p_publish) then raise exception 'Unknown month'; end if;
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
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
REVOKE ALL ON FUNCTION duty_private.cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.cancel_draft(text, bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_cancel_draft(text, bigint) TO authenticated, service_role;

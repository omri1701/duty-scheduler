-- Match the scheduler's cross-month weekend ownership, including special Saturday duties.
create function duty_private.month_days(p_month text)
returns table(calendar_day date,assignment_day date)
language sql stable security invoker set search_path='' as $$
 select g::date,duty_private.assignment_day(g::date)
 from generate_series(
  (p_month||'-01')::date-case when duty_private.assignment_day((p_month||'-01')::date)=(p_month||'-01')::date-1 then 1 else 0 end,
  ((p_month||'-01')::date+interval '1 month'-interval '1 day')::date+case when extract(dow from ((p_month||'-01')::date+interval '1 month'-interval '1 day'))=5 then 1 else 0 end,
  interval '1 day'
 ) g
$$;
revoke execute on function duty_private.month_days(text) from public,anon,authenticated;

create or replace function duty_private.save_schedule(p_state jsonb,p_revision bigint,p_publish text default null) returns void language plpgsql security definer set search_path='' as $$
declare x record; item jsonb; d date; ad date; a public.duty_assignments; payload jsonb;
begin
 if not duty_private.is_manager() then raise exception 'Manager access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if jsonb_typeof(p_state->'assignments') is distinct from 'object' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or jsonb_typeof(p_state->'specials') is distinct from 'array' or jsonb_typeof(p_state->'splitWeekends') is distinct from 'array' then raise exception 'Invalid schedule'; end if;
 if length(p_state::text)>2000000 then raise exception 'Schedule too large'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  update public.duty_members set name=x.value->>'name',color=x.value->>'color',active=case when role='manager' then true else (x.value->>'active')::boolean end,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown team member'; end if;
 end loop;
 for x in select * from jsonb_each(p_state->'months') loop
  insert into public.duty_months(month,deadline,status,generated) values(x.key,(x.value->>'deadline')::date,case when x.value->>'status'='published' and exists(select 1 from public.duty_publications where month=x.key) then 'published' else 'draft' end,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,status=excluded.status,generated=excluded.generated;
 end loop;
 delete from public.duty_assignments; delete from public.duty_specials; delete from public.duty_split_weekends;
 for item in select value from jsonb_array_elements(p_state->'specials') loop
  insert into public.duty_specials values((item->>'id')::uuid,item->>'title',(item->>'start')::date,(item->>'end')::date,(item->>'extra')::numeric);
 end loop;
 if exists(select 1 from public.duty_specials first_special join public.duty_specials other_special on first_special.id<other_special.id and first_special.start_day<other_special.end_day and other_special.start_day<first_special.end_day) then raise exception 'Special dates overlap'; end if;
 for item in select value from jsonb_array_elements(p_state->'splitWeekends') loop insert into public.duty_split_weekends values((item#>>'{}')::date) on conflict do nothing; end loop;
 for x in select * from jsonb_each(p_state->'assignments') loop
  insert into public.duty_assignments values(x.key::date,nullif(x.value->>'primary','')::uuid,nullif(x.value->>'secondary','')::uuid,coalesce((x.value->>'override')::boolean,false));
 end loop;
 if p_publish is not null then
  if not exists(select 1 from public.duty_months where month=p_publish) then raise exception 'Unknown month'; end if;
  for d in select calendar_day from duty_private.month_days(p_publish) loop
   ad:=duty_private.assignment_day(d); select * into a from public.duty_assignments where day=ad;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints where member_id in (a.primary_id,a.secondary_id) and day=d and kind='no') then raise exception 'Availability conflict on %',d; end if;
  end loop;
  -- Keep the last published snapshot while the manager works on a new draft.
  select jsonb_build_object('assignments',coalesce(jsonb_object_agg(day::text,jsonb_strip_nulls(jsonb_build_object('primary',coalesce(primary_id::text,''),'secondary',secondary_id,'override',manager_override))),'{}'::jsonb)) into payload from public.duty_assignments where day in (select assignment_day from duty_private.month_days(p_publish));
  payload:=payload||jsonb_build_object('specials',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'start',start_day,'end',end_day,'extra',extra)) from public.duty_specials where start_day<(p_publish||'-01')::date+interval '1 month'+case when extract(dow from ((p_publish||'-01')::date+interval '1 month'-interval '1 day'))=5 then interval '1 day' else interval '0 days' end and end_day>(p_publish||'-01')::date-case when extract(dow from (p_publish||'-01')::date)=6 then 1 else 0 end),'[]'::jsonb),'splitWeekends',coalesce((select jsonb_agg(friday::text) from public.duty_split_weekends where friday>=(p_publish||'-01')::date-case when extract(dow from (p_publish||'-01')::date)=6 then 1 else 0 end and friday<(p_publish||'-01')::date+interval '1 month'),'[]'::jsonb));
  insert into public.duty_publications(month,payload,published_by) values(p_publish,payload,auth.uid()) on conflict(month) do update set payload=excluded.payload,published_at=now(),published_by=excluded.published_by;
  update public.duty_months set status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

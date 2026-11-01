-- Non-weekend members (decision 2026-11-01): an admin can mark any approved member as
-- non-weekend. It is a standing setting. Generate never places that member on a weekend
-- duty (either half of a split weekend and holiday weekends included); a weekend the
-- manager already locked to them is kept, never deleted. Plan the month proposes a
-- +1 Permanent change for them each month (client planner; the checked confirmation
-- needs no change: the change is an ordinary, editable per-person change).
-- lib/scheduling/domain.ts (solver eligibility) and lib/scheduling/validate.ts apply the
-- same rule. Only the admin-only checked RPC writes the column; RLS reads are unchanged.

ALTER TABLE public.duty_members ADD COLUMN no_weekends boolean DEFAULT false NOT NULL;

-- Source: schemas/functions/duty_private/set_no_weekends.sql
-- Standing non-weekend setting (decision 2026-11-01): Generate never places the member
-- on a weekend duty, and Plan the month proposes a +1 Permanent change each month.
-- Existing locked weekends are kept; the plan shows a warning for them.
CREATE FUNCTION duty_private.set_no_weekends(p_member uuid, p_no_weekends boolean, p_revision bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_no_weekends is null then raise exception 'Choose whether this member takes weekends'; end if;
 update public.duty_members set no_weekends=p_no_weekends where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/public/duty_set_no_weekends.sql
CREATE FUNCTION public.duty_set_no_weekends(p_member uuid, p_no_weekends boolean, p_revision bigint) RETURNS void
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.set_no_weekends(p_member,p_no_weekends,p_revision)$$;

-- Source: schemas/functions/duty_private/generation_facts.sql
CREATE OR REPLACE FUNCTION duty_private.generation_facts(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare duties jsonb:=duty_private.generation_duties(p_month); meta public.duty_allocations; neighbors jsonb;
begin
 select x.* into meta from public.duty_allocations x join public.duty_months m using(month)
 where x.month=p_month and x.publication_id is not distinct from (case when m.status='published' then m.current_publication_id end);
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'ownerMonth',m.month,'start',a.day,'end',a.end_day,'engineer',a.primary_id,
  'source',case when a.publication_id is null then 'working' else 'published' end) order by m.month,a.day,a.id),'[]') into neighbors
 from public.duty_months m join public.duty_assignments a on duty_private.duty_owner(a.day)=m.month
 and (a.publication_id=m.current_publication_id or (m.status='draft' and a.publication_id is null))
 where m.month in (to_char((p_month||'-01')::date-interval '1 month','YYYY-MM'),to_char((p_month||'-01')::date+interval '1 month','YYYY-MM')) and a.primary_id is not null;
 return jsonb_build_object('month',p_month,'duties',duties,'neighbors',neighbors,
  -- noWeekends appears only when set, so other members' facts (and fingerprints) are unchanged.
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',id,'active',active,'approved',status='approved','eligible',status='approved' and active)
   ||case when no_weekends then jsonb_build_object('noWeekends',true) else '{}'::jsonb end order by id) from public.duty_members),'[]'),
  'seniority',coalesce((select jsonb_agg(id order by seniority,joined_at,id) from public.duty_members where status='approved' and active),'[]'),
  'constraints',coalesce((select jsonb_object_agg(member_id,days) from (select member_id,jsonb_object_agg(day,kind order by day) days from public.duty_constraints
    where day>=(duties->0->>'startDate')::date and day<(duties->-1->>'endDate')::date group by member_id) c),'{}'),
  'allocation',meta.allocation,'allocationId',meta.allocation_id,'locks',coalesce((select jsonb_agg(jsonb_build_object('dutyId',a.day,'engineer',a.primary_id) order by a.day) from public.duty_assignments a join public.duty_months m on m.month=p_month where duty_private.duty_owner(a.day)=p_month and a.locked and a.publication_id is not distinct from (case when m.status='published' then m.current_publication_id end)),'[]'),'approvals',coalesce(meta.approvals,'[]'),
  'sourcePublicationId',meta.source_publication_id,'generation',meta.generation);
end $$;

-- Source: schemas/functions/duty_private/save_generation.sql
CREATE OR REPLACE FUNCTION duty_private.save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare ctx jsonb; f jsonb; checked jsonb; meta public.duty_allocations; d jsonb; s jsonb; instant bigint;
begin
 ctx:=duty_private.generation_context(p_month,p_revision);
 if p_fingerprint IS DISTINCT FROM ctx->>'fingerprint' then raise exception 'Generation inputs changed. Refresh and review.' using errcode='40001'; end if;
 if p_seed is null or p_seed<0 or length(p_assignments::text)>100000 then raise exception 'Invalid generation result'; end if;
 -- Sample after obtaining the workspace lock, and again immediately before the
 -- mutation. A lock wait can cross opening without any revision change.
 if duty_private.compensation_now()>=(ctx->>'coverageStartMs')::bigint then raise exception 'generation-window-closed'; end if;
 if not exists(select 1 from public.duty_months where month=p_month and status='draft') then raise exception 'An open month draft is required'; end if;
 select * into meta from public.duty_allocations where month=p_month and publication_id is null;
 if meta.month is null then raise exception 'Confirmed allocation required'; end if;
 if meta.accounting_fingerprint IS DISTINCT FROM ctx->>'accountingFingerprint' then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
 f:=ctx->'facts';
 if meta.calendar_fingerprint<>md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(f->'duties') d)) then raise exception 'Calendar changed. Confirm allocation again.' using errcode='40001'; end if;
 checked:=duty_private.generation_validate(f,meta.allocation->'targetsUnits',p_assignments);
 -- Generate never places a non-weekend member on a weekend duty (either half of a split
 -- weekend included). A weekend the manager locked to them is kept, never deleted; manual
 -- calendar edits stay the manager's call, so publication does not apply this rule.
 if exists(select 1 from jsonb_array_elements(f->'duties') d join jsonb_array_elements(f->'members') m on m->>'id'=p_assignments->(d->>'id')->>'primary'
  where d->>'weekendId' is not null and m->'noWeekends'='true'
   and not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',d->'id','engineer',m->'id'))) then raise exception 'non-weekend-primary'; end if;
 if meta.source_publication_id is null then
  -- Re-planned now and projected after, as generation_context and Confirm do.
  s:=duty_private.compensation_state();
  instant:=greatest((ctx->>'actualAtMs')::bigint,coalesce((s->'events'->-1->>'at')::bigint,0));
  s:=duty_private.compensation_replan(s,p_month,instant);
  s:=duty_private.compensation_reconcile(s,greatest(instant,(ctx->>'coverageStartMs')::bigint,coalesce((s->'events'->-1->>'at')::bigint,0)),false);
  perform duty_private.allocation_compile(f,meta.allocation,checked->'actualUnits',s);
 end if;
 if duty_private.compensation_now()>=(ctx->>'coverageStartMs')::bigint then raise exception 'generation-window-closed'; end if;
 for d in select value from jsonb_array_elements(f->'duties') loop
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,title,extra_points,saturday_extra_points)
  values((d->>'startDate')::date,(d->>'endDate')::date,(p_assignments->(d->>'id')->>'primary')::uuid,(d->>'secondary')::uuid,d->>'title',(d->>'extra')::numeric,coalesce((d->>'saturdayExtra')::numeric,0))
  on conflict(publication_id,day) do update set primary_id=excluded.primary_id;
 end loop;
 update public.duty_allocations set generation=jsonb_build_object('seed',p_seed,'sourceRevision',p_revision,'fingerprint',p_fingerprint,
  'savedAtMs',ctx->'actualAtMs','metrics',checked) where month=p_month and publication_id is null;
 update public.duty_months set generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
 return duty_private.generation_context(p_month,(select revision from public.duty_workspace where id));
end $$;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.set_no_weekends(uuid, boolean, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.set_no_weekends(uuid, boolean, bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_set_no_weekends(uuid, boolean, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_set_no_weekends(uuid, boolean, bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Non-weekend members rejoin the weekend rotation level (decision 2026-11-05): clearing the
-- setting records the first month whose duties count for them again, like a new member.
-- Existing members get NULL (no change); generation facts carry it only when set.

ALTER TABLE public.duty_members ADD COLUMN weekends_from text;
ALTER TABLE public.duty_members ADD CONSTRAINT duty_members_weekends_from_check CHECK ((weekends_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text));

-- Source: schemas/functions/duty_private/set_no_weekends.sql
-- Standing non-weekend setting (decision 2026-11-01): Generate never places the member
-- on a weekend duty, and Plan the month proposes a +1 Permanent change each month.
-- Existing locked weekends are kept; the plan shows a warning for them.
-- Clearing it (decision 2026-11-05) rejoins the weekend rotation level with the team, like
-- a new member: weekends_from is the month after every month generated or published so far.
CREATE OR REPLACE FUNCTION duty_private.set_no_weekends(p_member uuid, p_no_weekends boolean, p_revision bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_no_weekends is null then raise exception 'Choose whether this member takes weekends'; end if;
 update public.duty_members set no_weekends=p_no_weekends,
  weekends_from=case when no_weekends and not p_no_weekends then coalesce((select to_char((max(month)||'-01')::date+interval '1 month','YYYY-MM')
   from public.duty_months where generated or current_publication_id is not null),weekends_from) else weekends_from end
  where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

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
  -- noWeekends and weekendsFrom appear only when set, so other members' facts (and fingerprints) are unchanged.
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',id,'active',active,'approved',status='approved','eligible',status='approved' and active)
   ||case when no_weekends then jsonb_build_object('noWeekends',true) else '{}'::jsonb end
   ||case when weekends_from is not null then jsonb_build_object('weekendsFrom',weekends_from) else '{}'::jsonb end order by id) from public.duty_members),'[]'),
  'seniority',coalesce((select jsonb_agg(id order by seniority,joined_at,id) from public.duty_members where status='approved' and active),'[]'),
  'constraints',coalesce((select jsonb_object_agg(member_id,days) from (select member_id,jsonb_object_agg(day,kind order by day) days from public.duty_constraints
    where day>=(duties->0->>'startDate')::date and day<(duties->-1->>'endDate')::date group by member_id) c),'{}'),
  'allocation',meta.allocation,'allocationId',meta.allocation_id,'locks',coalesce((select jsonb_agg(jsonb_build_object('dutyId',a.day,'engineer',a.primary_id) order by a.day) from public.duty_assignments a join public.duty_months m on m.month=p_month where duty_private.duty_owner(a.day)=p_month and a.locked and a.publication_id is not distinct from (case when m.status='published' then m.current_publication_id end)),'[]'),'approvals',coalesce(meta.approvals,'[]'),
  'sourcePublicationId',meta.source_publication_id,'generation',meta.generation);
end $$;

NOTIFY pgrst, 'reload schema';

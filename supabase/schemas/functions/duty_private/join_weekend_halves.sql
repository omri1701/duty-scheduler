-- A weekend whose two published halves end up on the same person (same cover and lock, not
-- started) is one ordinary Friday–Sunday duty again (decisions 2026-11-07), as Edit duty does:
-- an approved swap that hands someone the other half joins them. Each date keeps its own
-- extra; the copied plan's lock of Saturday goes with the row. True when it joined. Internal:
-- only resolve_swap calls it, on the version it is creating, before the pointer moves.
CREATE FUNCTION duty_private.join_weekend_halves(p_publication uuid, p_day date) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare friday date; fri public.duty_assignments; sat public.duty_assignments;
begin
 -- Only a version being made: a published one (current or history) never changes.
 if exists(select 1 from public.duty_months where current_publication_id=p_publication) then raise exception 'published-version-immutable'; end if;
 if p_day is null or extract(dow from p_day) not in (5,6) then return false; end if;
 friday:=case when extract(dow from p_day)=6 then p_day-1 else p_day end;
 select * into fri from public.duty_assignments a where a.publication_id=p_publication and a.day=friday and a.end_day=friday+1;
 select * into sat from public.duty_assignments a where a.publication_id=p_publication and a.day=friday+1 and a.end_day=friday+2;
 if fri.id is null or sat.id is null or friday<(now() at time zone 'Asia/Jerusalem')::date or fri.primary_id is null or fri.primary_id is distinct from sat.primary_id
  or fri.secondary_id is distinct from sat.secondary_id or fri.locked<>sat.locked then return false; end if;
 delete from public.duty_assignments where id=sat.id;
 update public.duty_assignments set end_day=friday+2,saturday_extra_points=sat.extra_points,manager_override=fri.manager_override or sat.manager_override,
  title=case when fri.title='' then sat.title else fri.title end where id=fri.id;
 update public.duty_allocations a set locks=(select coalesce(jsonb_agg(l),'[]') from jsonb_array_elements(a.locks) l where l->>'dutyId'<>sat.day::text)
 where a.publication_id=p_publication;
 return true;
end $$;

CREATE FUNCTION duty_private.reconcile_member_swaps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m text;
begin
 -- A party who is deactivated or loses approval never holds a request open:
 -- reconcile_swaps invalidates their pending swaps (decision 2026-11-01).
 perform 1 from public.duty_workspace where id for update;
 for m in select distinct month from public.duty_swap_requests
  where status in ('awaiting_engineer','awaiting_admin') and new.id in (requester_id,other_id) order by month loop
  perform duty_private.reconcile_swaps(m);
 end loop;
 return new;
end $$;

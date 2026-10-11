CREATE FUNCTION duty_private.reconcile_publication_swaps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform 1 from public.duty_workspace where id for update;
 perform duty_private.reconcile_swaps(new.month);
 return new;
end $$;

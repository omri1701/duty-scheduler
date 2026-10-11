CREATE FUNCTION duty_private.join_team(p_name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare u auth.users; added integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into u from auth.users where id=auth.uid() and email_confirmed_at is not null and not is_anonymous;
 if u.id is null then raise exception 'A verified account is required' using errcode='42501'; end if;
 perform 1 from public.duty_workspace where id for update;
 insert into public.duty_members(id,email,name,seniority,color)
 values(u.id,lower(u.email),left(coalesce(nullif(trim(p_name),''),split_part(u.email,'@',1)),80),(select coalesce(max(seniority),0)+1 from public.duty_members),(array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9'])[(select count(*)::int%12+1 from public.duty_members)]) on conflict(id) do nothing;
 get diagnostics added=row_count;
 if added>0 then update public.duty_workspace set revision=revision+1 where id; end if;
end $$;

-- Append three pastels to the default member palette; existing members keep their colors.
CREATE OR REPLACE FUNCTION duty_private.join_team(p_name text) RETURNS void
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
 values(u.id,lower(u.email),left(coalesce(nullif(trim(p_name),''),split_part(u.email,'@',1)),80),(select coalesce(max(seniority),0)+1 from public.duty_members),(array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9','#dbb677','#f1c3ba','#a5dfac'])[(select count(*)::int%15+1 from public.duty_members)]) on conflict(id) do nothing;
 get diagnostics added=row_count;
 if added>0 then update public.duty_workspace set revision=revision+1 where id; end if;
end $$;

CREATE OR REPLACE FUNCTION duty_private.add_temporary_member(p_name text, p_revision bigint) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare member_id uuid := gen_random_uuid();
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 insert into public.duty_members(id,name,is_temporary,status,active,seniority,color)
 values(member_id,trim(p_name),true,'approved',true,
  (select coalesce(max(seniority),0)+1 from public.duty_members),
  (array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9','#dbb677','#f1c3ba','#a5dfac'])[(select count(*)::int%15+1 from public.duty_members)]);
 update public.duty_workspace set revision=revision+1 where id;
 return member_id;
end $$;

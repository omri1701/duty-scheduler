CREATE FUNCTION duty_private.add_temporary_member(p_name text, p_revision bigint) RETURNS uuid
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
  (array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9'])[(select count(*)::int%12+1 from public.duty_members)]);
 update public.duty_workspace set revision=revision+1 where id;
 return member_id;
end $$;

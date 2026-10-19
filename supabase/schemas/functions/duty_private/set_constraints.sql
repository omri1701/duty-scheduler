CREATE FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d date; m text; manager boolean;
begin
 perform duty_private.check_revision(p_revision);
 manager:=duty_private.is_manager();
 if (not manager and p_member<>auth.uid()) or not exists(select 1 from public.duty_members where id=p_member and status='approved') then raise exception 'Not allowed' using errcode='42501'; end if;
 if p_kind not in ('no','prefer','clear') or p_kind is null or coalesce(cardinality(p_days),0) not between 1 and 62 or length(coalesce(p_note,''))>300 then raise exception 'Invalid constraints'; end if;
 foreach d in array p_days loop
  if d is null then raise exception 'Invalid date'; end if;
  m:=to_char(d,'YYYY-MM');
  insert into public.duty_months(month,deadline) values(m,date_trunc('month',d)::date-7) on conflict do nothing;
  if not manager and exists(select 1 from public.duty_months where month=m and (status='published' or deadline < (now() at time zone 'Asia/Jerusalem')::date)) then raise exception 'Constraints are closed for this month' using errcode='42501'; end if;
  if p_kind='clear' then delete from public.duty_constraints where member_id=p_member and day=d;
  else insert into public.duty_constraints(member_id,day,kind,note) values(p_member,d,p_kind,trim(coalesce(p_note,''))) on conflict(member_id,day) do update set kind=excluded.kind,note=excluded.note; end if;
  -- Availability is independent of the working schedule. In particular, an
  -- admin constraint edit must not create an empty draft of a published month.
 end loop;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

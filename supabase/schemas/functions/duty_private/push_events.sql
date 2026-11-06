-- Records one notification for one member, once (the dedupe key), only when they
-- can receive it: a signed-in, approved, active member with a registered device who
-- has not switched that kind off. Returns whether a new row was recorded.
CREATE FUNCTION duty_private.push_enqueue(p_member uuid, p_kind text, p_key text, p_params jsonb, p_url text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_notification_settings; wanted boolean;
begin
 if p_member is null or not exists(select 1 from public.duty_members where id=p_member and auth_user_id is not null and status='approved' and active)
  or not exists(select 1 from public.duty_push_subscriptions where member_id=p_member) then return false; end if;
 select * into s from public.duty_notification_settings where member_id=p_member;
 wanted:=case
  when p_kind in ('deadline_3','deadline_1') then coalesce(s.deadlines,true)
  when p_kind in ('published','republished') then coalesce(s.published,true)
  when p_kind like 'swap\_%' then coalesce(s.swaps,true)
  when p_kind='edit' then coalesce(s.edits,true)
  when p_kind='remind_evening' then coalesce(s.evening,true)
  when p_kind='remind_morning' then coalesce(s.morning,true)
  when p_kind='member_waiting' then coalesce(s.members,true)
  when p_kind='test' then true
  else false end;
 if not wanted then return false; end if;
 insert into public.duty_push_notifications(member_id,kind,dedupe_key,params,url) values(p_member,p_kind,p_key,coalesce(p_params,'{}'::jsonb),p_url)
 on conflict(dedupe_key) do nothing;
 return found;
end $$;

-- Publishing a month tells everyone; a later change to a published month that is
-- not an approved swap (an admin's published-duty edit, or deleting the live
-- version) tells each member whose duty, cover or points changed. The member who
-- made the change is not told. A notification problem never blocks the change.
CREATE FUNCTION duty_private.push_month_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=auth.uid(); today date:=(now() at time zone 'Asia/Jerusalem')::date; r record; v integer;
begin
 begin
  if old.status='draft' and new.status='published' then
   select p.version into v from public.duty_publications p where p.id=new.current_publication_id;
   for r in select id from public.duty_members where status='approved' and active and auth_user_id is not null and id is distinct from actor loop
    perform duty_private.push_enqueue(r.id,case when old.current_publication_id is null then 'published' else 'republished' end,
     'published:'||new.current_publication_id||':'||r.id,jsonb_build_object('month',new.month,'version',v),'/?tab=schedule&month='||new.month);
   end loop;
  elsif old.status='published' and new.status='published'
   and not exists(select 1 from public.duty_swap_requests s where s.result_publication_id=new.current_publication_id) then
   for r in
    with o as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=old.current_publication_id),
     n as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=new.current_publication_id),
     d as (select coalesce(n.day,o.day) as day,o.primary_id as op,o.secondary_id as os,n.primary_id as np,n.secondary_id as ns,
       (o.points is distinct from n.points or o.end_day is distinct from n.end_day) as reshaped
      from o full join n on n.day=o.day where coalesce(n.day,o.day)>=today),
     affected as (
      select d.day,x.member from d cross join lateral (values (d.op),(d.np)) x(member) where d.op is distinct from d.np
      union select d.day,x.member from d cross join lateral (values (d.os),(d.ns)) x(member) where d.os is distinct from d.ns
      union select d.day,x.member from d cross join lateral (values (d.np),(d.ns)) x(member) where d.reshaped)
    select a.member,min(a.day) as first_day,count(distinct a.day) as days from affected a
    where a.member is not null and a.member is distinct from actor group by a.member
   loop
    perform duty_private.push_enqueue(r.member,'edit','edit:'||new.current_publication_id||':'||r.member,
     jsonb_build_object('month',new.month,'day',r.first_day,'count',r.days),'/?tab=schedule&month='||new.month);
   end loop;
  end if;
 exception when others then
  raise warning 'duty push (month %): %',new.month,sqlerrm;
 end;
 return null;
end $$;

-- Swap requests tell only the people involved: who must answer a new request, the
-- other parties when someone accepts, everyone involved when it is declined,
-- rejected or approved, and the admins when it waits for their approval. The
-- explanation text is never sent; only the two dates.
CREATE FUNCTION duty_private.push_swap_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=auth.uid(); params jsonb; url text; who uuid; side text; answered uuid;
begin
 begin
  params:=jsonb_build_object('month',new.month,'fromDay',new.from_day,'toDay',new.to_day);
  url:='/?tab=schedule&month='||new.month;
  if tg_op='INSERT' then
   if new.status='awaiting_engineer' then
    foreach who in array array[new.other_id,case when new.proposed_by is not null then new.requester_id end] loop
     if who is not null and who is distinct from actor then perform duty_private.push_enqueue(who,'swap_new','swap:'||new.id||':new:'||who,params,url); end if;
    end loop;
   end if;
  else
   -- The published duty changed hands while waiting: its new holder is asked.
   if new.status='awaiting_engineer' and new.other_id is distinct from old.other_id and new.other_id is distinct from actor then
    perform duty_private.push_enqueue(new.other_id,'swap_new','swap:'||new.id||':new:'||new.other_id,params,url);
   end if;
   side:=case when new.accepted_by is not null and old.accepted_by is null then 'other'
    when new.requester_accepted_at is not null and old.requester_accepted_at is null then 'requester' end;
   if side is not null then
    answered:=case side when 'other' then new.other_id else new.requester_id end;
    foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
     if who is not null and who is distinct from actor and who is distinct from answered then
      perform duty_private.push_enqueue(who,'swap_accepted','swap:'||new.id||':accepted-'||side||':'||who,params,url);
     end if;
    end loop;
   end if;
   if new.status is distinct from old.status then
    if new.status='awaiting_admin' then
     for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
      where r.can_manage and m.status='approved' and m.active and m.id is distinct from actor loop
      perform duty_private.push_enqueue(who,'swap_awaiting_admin','swap:'||new.id||':admin:'||who,params,url);
     end loop;
    elsif new.status in ('declined','rejected','approved') then
     foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
      if who is not null and who is distinct from actor then
       perform duty_private.push_enqueue(who,'swap_'||new.status,'swap:'||new.id||':'||new.status||':'||who,params,url);
      end if;
     end loop;
    end if;
   end if;
  end if;
 exception when others then
  raise warning 'duty push (swap %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

-- A new sign-up waits for approval: every admin who wants to know is told.
CREATE FUNCTION duty_private.push_member_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare who uuid;
begin
 begin
  for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
   where r.can_manage and m.status='approved' and m.active loop
   perform duty_private.push_enqueue(who,'member_waiting','member:'||new.id||':'||who,jsonb_build_object('name',left(new.name,80)),'/?tab=team');
  end loop;
 exception when others then
  raise warning 'duty push (member %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

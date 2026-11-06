-- Web push (decision 2026-11-06, user review): no "Send a test" in Settings. Removes the test
-- RPC, its one-a-minute limit and the 'test' kind, with any test notifications already recorded
-- (their deliveries go with them). Real alerts are unchanged.
DROP FUNCTION public.duty_send_test_notification();
DROP FUNCTION duty_private.send_test_notification();
DELETE FROM public.duty_push_notifications WHERE kind='test';
ALTER TABLE public.duty_push_notifications DROP CONSTRAINT duty_push_notifications_kind_check;
ALTER TABLE public.duty_push_notifications ADD CONSTRAINT duty_push_notifications_kind_check CHECK ((kind = ANY (ARRAY['deadline_3'::text, 'deadline_1'::text, 'published'::text, 'republished'::text, 'edit'::text, 'swap_new'::text, 'swap_accepted'::text, 'swap_awaiting_admin'::text, 'swap_declined'::text, 'swap_rejected'::text, 'swap_approved'::text, 'remind_evening'::text, 'remind_morning'::text, 'member_waiting'::text])));

CREATE OR REPLACE FUNCTION duty_private.push_enqueue(p_member uuid, p_kind text, p_key text, p_params jsonb, p_url text) RETURNS boolean
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
  else false end;
 if not wanted then return false; end if;
 insert into public.duty_push_notifications(member_id,kind,dedupe_key,params,url) values(p_member,p_kind,p_key,coalesce(p_params,'{}'::jsonb),p_url)
 on conflict(dedupe_key) do nothing;
 return found;
end $$;


NOTIFY pgrst, 'reload schema';

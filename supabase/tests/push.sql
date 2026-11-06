-- Synthetic fixtures only, on an empty disposable LOCAL database. Always rolls back.
-- Web push (decision 2026-11-06): own-rows-only access and checked RPCs; who is told
-- what and when (deadlines, reminders with custom times, publication, edits, swaps,
-- sign-ups), per-kind switches, the member's language and idempotent sending.
begin;
do $$begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL'; end if;
end$$;
-- 1 admin, 2 and 3 engineers, 4 pending, 5 engineer without a device (after the cap check).
insert into auth.users(id,email,email_confirmed_at,is_anonymous) select
 ('76000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'push-test-'||i||'@example.invalid',now(),false from generate_series(1,6) i;
insert into public.duty_members(id,email,name,role,status,active,seniority) select id,email,'Push '||right(id::text,1),
 case when right(id::text,1)='1' then 'admin' else 'engineer' end,
 case when right(id::text,1)='4' then 'pending' else 'approved' end,true,right(id::text,1)::int from auth.users where right(id::text,1)<>'6';
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command; exception when others then
  if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;
 end;raise exception 'Unexpected acceptance: %',command;
end$$;
create function pg_temp.check(ok boolean, message text) returns void language plpgsql as $$begin
 if ok is not true then raise exception 'Check failed: %',message; end if;
end$$;
create function pg_temp.sent(member text, kind text) returns bigint language sql as $$
 select count(*) from public.duty_push_notifications where member_id=('76000000-0000-0000-0000-00000000000'||member)::uuid and duty_push_notifications.kind=sent.kind$$;
create temp table before_revision as select revision from public.duty_workspace;
grant select on before_revision to authenticated;

-- Anonymous callers reach nothing; clients cannot call the internal sender or write tables.
set local role anon;
select pg_temp.must_fail($c$select public.duty_set_language('he')$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_notification_settings()$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/anon-device',repeat('B',87),repeat('A',22))$c$,'permission denied');
select pg_temp.must_fail($c$select * from public.duty_push_subscriptions$c$,'permission denied');
reset role;
-- Calendar feeds of members 2 and 3 (made in English) follow only their own member's language.
insert into public.duty_calendar_feeds(member_id,token_hash,language) values
 ('76000000-0000-0000-0000-000000000002',sha256('feed-2'),'en'),('76000000-0000-0000-0000-000000000003',sha256('feed-3'),'en');
set local role authenticated;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
select pg_temp.must_fail($c$select duty_private.push_tick()$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.push_schedule(now())$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.push_dispatch(now())$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.push_settle(1,200,'{}',false)$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.push_enqueue('76000000-0000-0000-0000-000000000002','test','forged','{}','/?tab=schedule')$c$,'permission denied');
select pg_temp.must_fail($c$insert into public.duty_push_subscriptions(member_id,endpoint,p256dh,auth) values('76000000-0000-0000-0000-000000000002','https://fcm.googleapis.com/fcm/send/direct-write',repeat('B',87),repeat('A',22))$c$,'permission denied');
select pg_temp.must_fail($c$insert into public.duty_notification_settings(member_id) values('76000000-0000-0000-0000-000000000002')$c$,'permission denied');
select pg_temp.must_fail($c$insert into public.duty_push_notifications(member_id,kind,dedupe_key,url) values('76000000-0000-0000-0000-000000000002','test','forged','/?tab=team')$c$,'permission denied');
select pg_temp.must_fail($c$update public.duty_members set language='he' where id='76000000-0000-0000-0000-000000000002'$c$,'permission denied');

-- Language: only the caller's own row, any member including a pending one, no revision.
select public.duty_set_language('he');
select pg_temp.must_fail($c$select public.duty_set_language('fr')$c$,'Choose English or Hebrew');
select pg_temp.must_fail($c$select public.duty_set_language(null)$c$,'Choose English or Hebrew');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000004';
select public.duty_set_language('he');
select public.duty_set_language('en');
reset role;
select pg_temp.check((select revision from public.duty_workspace)=(select revision from before_revision),'language never touches the workspace revision');
select pg_temp.check((select jsonb_object_agg(right(id::text,1),coalesce(language,'-')) from public.duty_members)='{"1":"-","2":"he","3":"-","4":"en","5":"-"}','own language only');
select pg_temp.check((select jsonb_object_agg(right(member_id::text,1),language) from public.duty_calendar_feeds)='{"2":"he","3":"en"}','the own calendar feed follows the language');
select pg_temp.check(public.duty_load() is not null,'load still works');

-- Settings: defaults, full-object validation, own rows only, approved members only.
set local role authenticated;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
select pg_temp.check(public.duty_notification_settings()='{"deadlines":true,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"18:00","morning":true,"morningTime":"08:30","members":true,"devices":0}','defaults');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('{"deadlines":true}')$c$,'Invalid notification settings');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('{"deadlines":"yes","published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"20:15","morning":false,"morningTime":"07:00","members":true}')$c$,'Invalid notification settings');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('{"deadlines":true,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"20:15","morning":false,"morningTime":"07:00","members":true,"extra":1}')$c$,'Invalid notification settings');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('{"deadlines":true,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"24:00","morning":false,"morningTime":"07:00","members":true}')$c$,'Invalid notification time');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('{"deadlines":true,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"20:10","morning":false,"morningTime":"07:00","members":true}')$c$,'Invalid notification time');
select pg_temp.must_fail($c$select public.duty_set_notification_settings('[]')$c$,'Invalid notification settings');
-- Member 2: evening at 20:15, no morning reminder.
select pg_temp.check((public.duty_set_notification_settings('{"deadlines":true,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"20:15","morning":false,"morningTime":"07:00","members":true}')->>'eveningTime')='20:15','saved');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
select pg_temp.check((select count(*) from public.duty_notification_settings)=0,'others'' settings are invisible');
select pg_temp.check(public.duty_notification_settings()->>'eveningTime'='18:00','own defaults');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000004';
select pg_temp.must_fail($c$select public.duty_notification_settings()$c$,'Member access required');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/pending-device',repeat('B',87),repeat('A',22))$c$,'Member access required');
select pg_temp.must_fail($c$select public.duty_send_test_notification()$c$,'Member access required');
-- Member 1 (admin) turns deadline reminders off.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
select public.duty_set_notification_settings('{"deadlines":false,"published":true,"swaps":true,"edits":true,"evening":true,"eveningTime":"18:00","morning":true,"morningTime":"08:30","members":true}');

-- Devices: only known push services and well-formed keys; an endpoint is unique and
-- moves to whoever registered it last; ten devices per member; delete only your own.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
select pg_temp.must_fail($c$select public.duty_send_test_notification()$c$,'push-no-device');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('http://fcm.googleapis.com/fcm/send/plain-http',repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://evil.example.com/fcm/send/device',repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com.evil.example/x/device',repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://user@fcm.googleapis.com/fcm/send/device',repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com:8443/fcm/send/device',repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription(null,repeat('B',87),repeat('A',22))$c$,'push-service-unsupported');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a','short',repeat('A',22))$c$,'push-keys-invalid');
select pg_temp.must_fail($c$select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a',repeat('B',87),'a+b/')$c$,'push-keys-invalid');
select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a',repeat('B',87),repeat('A',22));
select public.duty_save_push_subscription('https://web.push.apple.com/QGmBz-device-2b',repeat('C',87),repeat('A',22));
select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a',repeat('D',87),repeat('A',22));
select pg_temp.check(public.duty_notification_settings()->>'devices'='2','re-registering updates, never duplicates');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
select public.duty_save_push_subscription('https://updates.push.services.mozilla.com/wpush/v2/device-3',repeat('E',87),repeat('A',22));
select pg_temp.check((select count(*) from public.duty_push_subscriptions)=1,'own devices only');
select public.duty_delete_push_subscription('https://web.push.apple.com/QGmBz-device-2b');
-- A shared device: member 3 signs in on member 2's phone, then member 2 again.
select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a',repeat('F',87),repeat('A',22));
select pg_temp.check((select count(*) from public.duty_push_subscriptions)=2,'endpoint moved to its latest member');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/device-2a',repeat('D',87),repeat('A',22));
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
select public.duty_save_push_subscription('https://wns2-par02p.notify.windows.com/w/?token=device-1',repeat('G',87),repeat('A',22));
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000005';
select public.duty_save_push_subscription('https://fcm.googleapis.com/fcm/send/cap-'||i,repeat('H',87),repeat('A',22)) from generate_series(1,12) i;
select pg_temp.check(public.duty_notification_settings()->>'devices'='10','ten devices per member');
select public.duty_delete_push_subscription(endpoint) from public.duty_push_subscriptions;
select pg_temp.check(public.duty_notification_settings()->>'devices'='0','own devices deleted');
reset role;
select pg_temp.check((select jsonb_object_agg(endpoint,right(member_id::text,1)) from public.duty_push_subscriptions)
 ='{"https://fcm.googleapis.com/fcm/send/device-2a":"2","https://web.push.apple.com/QGmBz-device-2b":"2","https://updates.push.services.mozilla.com/wpush/v2/device-3":"3","https://wns2-par02p.notify.windows.com/w/?token=device-1":"1"}','device owners');
select pg_temp.check((select revision from public.duty_workspace)=(select revision from before_revision),'settings and devices never touch the workspace revision');

-- Recording: once per key, only for members who can receive that kind.
select pg_temp.check(duty_private.push_enqueue('76000000-0000-0000-0000-000000000002','test','fixture-key','{}','/?tab=schedule'),'recorded');
select pg_temp.check(not duty_private.push_enqueue('76000000-0000-0000-0000-000000000002','test','fixture-key','{}','/?tab=schedule'),'idempotent');
select pg_temp.check(not duty_private.push_enqueue('76000000-0000-0000-0000-000000000002','remind_morning','fixture-off','{}','/?tab=schedule'),'switched off');
select pg_temp.check(not duty_private.push_enqueue('76000000-0000-0000-0000-000000000005','test','fixture-no-device','{}','/?tab=schedule'),'no device');
select pg_temp.check(not duty_private.push_enqueue('76000000-0000-0000-0000-000000000004','test','fixture-pending','{}','/?tab=schedule'),'pending member');
select pg_temp.must_fail($c$select duty_private.push_enqueue('76000000-0000-0000-0000-000000000002','test','fixture-url','{}','https://evil.example/')$c$,'url_check');
delete from public.duty_push_notifications;

-- Constraint deadline for March 2027 (Israel UTC+2): 10:00 three days before to
-- everyone who wants it; 10:00 the day before only to members with no March constraints.
insert into public.duty_months(month,deadline) values('2027-03','2027-02-20'),('2027-05','2027-04-20');
insert into public.duty_constraints(member_id,day,kind,note) values('76000000-0000-0000-0000-000000000003','2027-03-05','no','fixture private reason');
select pg_temp.check(duty_private.push_schedule('2027-02-17 07:59Z')=0,'not before 10:00 three days before');
select pg_temp.check(duty_private.push_schedule('2027-02-17 08:00Z')=2,'three days before: members 2 and 3 (1 switched off, 5 no device)');
select pg_temp.check(duty_private.push_schedule('2027-02-17 12:00Z')=0,'three-day notice once');
select pg_temp.check(duty_private.push_schedule('2027-02-19 07:59Z')=0,'day-before notice waits for 10:00');
select pg_temp.check(duty_private.push_schedule('2027-02-19 08:00Z')=1,'day before: only member 2, who entered no March constraints');
select pg_temp.check(pg_temp.sent('2','deadline_1')=1 and pg_temp.sent('3','deadline_1')=0 and pg_temp.sent('3','deadline_3')=1,'deadline recipients');
select pg_temp.check(duty_private.push_schedule('2027-02-20 21:00Z')=0,'nothing after the deadline day');
select pg_temp.check((select params from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000002' and kind='deadline_3')
 ='{"month":"2027-03","deadline":"2027-02-20"}' and (select url from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000002' and kind='deadline_3')='/?tab=availability&month=2027-03','deadline params and link');
-- A moved deadline is announced again; a published month never.
update public.duty_months set deadline='2027-02-22' where month='2027-03';
select pg_temp.check(duty_private.push_schedule('2027-02-19 08:00Z')=2,'moved deadline: a new three-day notice');
update public.duty_months set status='published' where month='2027-05';
select pg_temp.check(duty_private.push_schedule('2027-04-17 08:00Z')=0,'no deadline notice for a published month');
delete from public.duty_months where month='2027-05';

-- Publishing April 2027 (Israel UTC+3) by the admin tells everyone else once.
insert into public.duty_months(month,deadline) values('2027-04','2027-03-20');
insert into public.duty_publications(id,month,version,published_by) values
 ('76000000-0000-0000-0000-0000000000a1','2027-04',1,'76000000-0000-0000-0000-000000000001'),
 ('76000000-0000-0000-0000-0000000000a2','2027-04',2,'76000000-0000-0000-0000-000000000001'),
 ('76000000-0000-0000-0000-0000000000a3','2027-04',3,'76000000-0000-0000-0000-000000000001'),
 ('76000000-0000-0000-0000-0000000000a4','2027-04',4,'76000000-0000-0000-0000-000000000001');
-- Thursday 15 April: 2 on duty, 3 emergency cover; Tuesday 20 April: 3 on duty.
insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id) values
 ('76000000-0000-0000-0000-0000000000a1','2027-04-15','2027-04-16','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000003'),
 ('76000000-0000-0000-0000-0000000000a1','2027-04-20','2027-04-21','76000000-0000-0000-0000-000000000003',null);
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
update public.duty_months set status='published',current_publication_id='76000000-0000-0000-0000-0000000000a1',publication_sequence=1 where month='2027-04';
select pg_temp.check(pg_temp.sent('2','published')=1 and pg_temp.sent('3','published')=1 and pg_temp.sent('1','published')=0,'published to everyone but the publisher');
select pg_temp.check((select url from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000002' and kind='published')='/?tab=schedule&month=2027-04','publication link');

-- Reminders: evening before (3 at the default 18:00, 2 at 20:15) and morning of (3 at 08:30; 2 switched off).
select pg_temp.check(duty_private.push_schedule('2027-04-14 14:59Z')=0,'17:59: nothing yet');
select pg_temp.check(duty_private.push_schedule('2027-04-14 15:00Z')=1 and pg_temp.sent('3','remind_evening')=1,'18:00: emergency cover');
select pg_temp.check(duty_private.push_schedule('2027-04-14 17:14Z')=0,'20:14: member 2 not yet');
select pg_temp.check(duty_private.push_schedule('2027-04-14 17:15Z')=1 and pg_temp.sent('2','remind_evening')=1,'20:15: member 2''s own time');
select pg_temp.check(duty_private.push_schedule('2027-04-14 20:00Z')=0,'each once');
select pg_temp.check(duty_private.push_schedule('2027-04-15 05:29Z')=0,'08:29: not yet');
select pg_temp.check(duty_private.push_schedule('2027-04-15 05:30Z')=1 and pg_temp.sent('3','remind_morning')=1 and pg_temp.sent('2','remind_morning')=0,'08:30: only who wants it');
select pg_temp.check((select params from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000003' and kind='remind_morning')
 ='{"day":"2027-04-15","role":"secondary","endDay":"2027-04-16"}','reminder params');
-- A run three hours late misses the window instead of reminding late.
select pg_temp.check(duty_private.push_schedule('2027-04-19 18:00Z')=0,'21:00 the evening before 20 April: past the 18:00 window');

-- Reopen and republish: everyone hears of the new version.
update public.duty_months set status='draft' where month='2027-04';
insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id) values
 ('76000000-0000-0000-0000-0000000000a2','2027-04-15','2027-04-16','76000000-0000-0000-0000-000000000003','76000000-0000-0000-0000-000000000002'),
 ('76000000-0000-0000-0000-0000000000a2','2027-04-20','2027-04-21','76000000-0000-0000-0000-000000000002',null);
update public.duty_months set status='published',current_publication_id='76000000-0000-0000-0000-0000000000a2',publication_sequence=2 where month='2027-04';
select pg_temp.check(pg_temp.sent('2','republished')=1 and pg_temp.sent('3','republished')=1,'republished');
-- An admin edits the published month: 15 April primary/cover swap places, 20 April gets
-- an extra point. 3 changed on one date; 2 on both. The admin is not told.
insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,extra_points) values
 ('76000000-0000-0000-0000-0000000000a3','2027-04-15','2027-04-16','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000003',0),
 ('76000000-0000-0000-0000-0000000000a3','2027-04-20','2027-04-21','76000000-0000-0000-0000-000000000002',null,1);
update public.duty_months set current_publication_id='76000000-0000-0000-0000-0000000000a3',publication_sequence=3 where month='2027-04';
select pg_temp.check((select params from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000002' and kind='edit')='{"day":"2027-04-15","count":2,"month":"2027-04"}'
 and (select params from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000003' and kind='edit')='{"day":"2027-04-15","count":1,"month":"2027-04"}'
 and pg_temp.sent('1','edit')=0,'edit recipients');

-- Swaps: only the people involved, and admins when it waits for approval.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
insert into public.duty_swap_requests(id,month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,explanation)
values('76000000-0000-0000-0000-0000000000b1','2027-04','76000000-0000-0000-0000-0000000000a3','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000003',
 '2027-04-20','2027-04-21','2027-04-15','2027-04-16','fixture private explanation');
select pg_temp.check(pg_temp.sent('3','swap_new')=1 and pg_temp.sent('2','swap_new')=0 and pg_temp.sent('1','swap_new')=0,'new request: the counterpart');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
update public.duty_swap_requests set status='awaiting_admin',accepted_by=other_id,accepted_at=now() where id='76000000-0000-0000-0000-0000000000b1';
select pg_temp.check(pg_temp.sent('2','swap_accepted')=1 and pg_temp.sent('3','swap_accepted')=0 and pg_temp.sent('1','swap_awaiting_admin')=1
 and pg_temp.sent('2','swap_awaiting_admin')=0,'accepted: the requester; admins asked to approve');
-- The approval publishes a new version: the swap notice, not an edit notice.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
update public.duty_swap_requests set status='approved',resolved_at=now(),resolved_by='76000000-0000-0000-0000-000000000001',result_publication_id='76000000-0000-0000-0000-0000000000a4' where id='76000000-0000-0000-0000-0000000000b1';
insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,extra_points) values
 ('76000000-0000-0000-0000-0000000000a4','2027-04-15','2027-04-16','76000000-0000-0000-0000-000000000003',null,0),
 ('76000000-0000-0000-0000-0000000000a4','2027-04-20','2027-04-21','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000005',1);
update public.duty_months set current_publication_id='76000000-0000-0000-0000-0000000000a4',publication_sequence=4 where month='2027-04';
select pg_temp.check(pg_temp.sent('2','swap_approved')=1 and pg_temp.sent('3','swap_approved')=1 and pg_temp.sent('1','swap_approved')=0
 and pg_temp.sent('2','edit')=1 and pg_temp.sent('3','edit')=1,'approved: both members; no edit notice');
-- An admin proposes a swap: both members are asked; when one accepts, the other and the
-- admin hear; a decline tells everyone else involved.
insert into public.duty_swap_requests(id,month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,proposed_by)
values('76000000-0000-0000-0000-0000000000b2','2027-04','76000000-0000-0000-0000-0000000000a4','76000000-0000-0000-0000-000000000003','76000000-0000-0000-0000-000000000002',
 '2027-04-15','2027-04-16','2027-04-20','2027-04-21','76000000-0000-0000-0000-000000000001');
select pg_temp.check(pg_temp.sent('2','swap_new')=1 and pg_temp.sent('3','swap_new')=2,'proposed: both members asked');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
update public.duty_swap_requests set requester_accepted_at=now() where id='76000000-0000-0000-0000-0000000000b2';
select pg_temp.check(pg_temp.sent('2','swap_accepted')=2 and pg_temp.sent('1','swap_accepted')=1 and pg_temp.sent('3','swap_accepted')=0,'one side accepted');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
update public.duty_swap_requests set status='declined',resolved_at=now(),resolved_by='76000000-0000-0000-0000-000000000002' where id='76000000-0000-0000-0000-0000000000b2';
select pg_temp.check(pg_temp.sent('3','swap_declined')=1 and pg_temp.sent('1','swap_declined')=1 and pg_temp.sent('2','swap_declined')=0,'declined');
-- Member 3 switches swaps off: a new request reaches nobody.
set local role authenticated;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
select public.duty_set_notification_settings('{"deadlines":true,"published":true,"swaps":false,"edits":true,"evening":true,"eveningTime":"18:00","morning":true,"morningTime":"08:30","members":true}');
reset role;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
insert into public.duty_swap_requests(month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
values('2027-04','76000000-0000-0000-0000-0000000000a4','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000003','2027-04-20','2027-04-21','2027-04-15','2027-04-16');
select pg_temp.check(pg_temp.sent('3','swap_new')=2,'swaps switched off');
select pg_temp.check(not exists(select 1 from public.duty_push_notifications where params::text ~ 'private'),'notes and explanations never recorded');
-- Asked again: after the counterpart's consent is reset, a new acceptance asks the admins again.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
insert into public.duty_swap_requests(id,month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
values('76000000-0000-0000-0000-0000000000b3','2027-04','76000000-0000-0000-0000-0000000000a4','76000000-0000-0000-0000-000000000002','76000000-0000-0000-0000-000000000003','2027-04-15','2027-04-16','2027-04-20','2027-04-21');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
update public.duty_swap_requests set status='awaiting_admin',accepted_by=other_id,accepted_at='2027-04-01 10:00Z' where id='76000000-0000-0000-0000-0000000000b3';
set local request.jwt.claim.sub='';
update public.duty_swap_requests set status='awaiting_engineer',accepted_by=null,accepted_at=null where id='76000000-0000-0000-0000-0000000000b3';
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
update public.duty_swap_requests set status='awaiting_admin',accepted_by=other_id,accepted_at='2027-04-01 11:00Z' where id='76000000-0000-0000-0000-0000000000b3';
select pg_temp.check((select count(*) from public.duty_push_notifications where kind='swap_awaiting_admin' and params->>'request'='76000000-0000-0000-0000-0000000000b3')=2
 and (select count(*) from public.duty_push_notifications where kind='swap_accepted' and params->>'request'='76000000-0000-0000-0000-0000000000b3')=2,'each round is told');
-- Asked, then cancelled before the next send (as an admin's edit does in the same step): never sent.
insert into public.duty_swap_requests(id,month,source_publication_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
values('76000000-0000-0000-0000-0000000000b4','2027-04','76000000-0000-0000-0000-0000000000a4','76000000-0000-0000-0000-000000000003','76000000-0000-0000-0000-000000000002','2027-04-15','2027-04-16','2027-04-20','2027-04-21');
update public.duty_swap_requests set status='invalidated',resolved_at=now() where id='76000000-0000-0000-0000-0000000000b4';
select pg_temp.check((select count(*) from public.duty_push_notifications where kind='swap_new' and params->>'request'='76000000-0000-0000-0000-0000000000b4')=1,'asked');
-- Deleting the live version brings the edited version back: everyone whose duty changes again is told again.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
update public.duty_months set current_publication_id='76000000-0000-0000-0000-0000000000a3' where month='2027-04';
select pg_temp.check(pg_temp.sent('2','edit')=2 and pg_temp.sent('3','edit')=2,'rolled back to an earlier version: told again');

-- A new sign-up: admins are told, with the name only.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000006';
insert into public.duty_members(id,email,name) values('76000000-0000-0000-0000-000000000006','push-test-6@example.invalid','New Joiner');
select pg_temp.check((select params from public.duty_push_notifications where kind='member_waiting' and member_id='76000000-0000-0000-0000-000000000001')='{"name":"New Joiner"}'
 and (select count(*) from public.duty_push_notifications where kind='member_waiting')=1,'member waiting: admins only');

-- Own rows only: each member reads just their notifications and deliveries.
set local role authenticated;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
select pg_temp.check((select count(*) from public.duty_push_notifications where member_id<>'76000000-0000-0000-0000-000000000003')=0
 and (select count(*) from public.duty_push_notifications)>0,'own notifications only');
select pg_temp.check(public.duty_send_test_notification() and not public.duty_send_test_notification(),'test notification once a minute');
reset role;

-- Sending: without pg_net and the Vault configuration nothing leaves; old ones expire.
update public.duty_push_notifications set created_at=now()-interval '7 hours' where kind='deadline_3' and member_id='76000000-0000-0000-0000-000000000003' and params->>'deadline'='2027-02-20';
do $$declare request bigint; body jsonb; total integer; moved bigint; sent_id bigint; gone_id bigint; retry_id bigint; reject_id bigint;
begin
 if to_regnamespace('net') is not null then raise notice 'pg_net is installed here: the stubbed sending checks are skipped'; return; end if;
 perform pg_temp.check(duty_private.push_dispatch(now())=0,'unconfigured: nothing sent');
 perform pg_temp.check((select count(*) from public.duty_push_notifications where status='expired')=1,'six hours late: expired');
 perform pg_temp.check((select count(*) from public.duty_push_deliveries)=0,'unconfigured: no deliveries');
 -- A stand-in for pg_net's interface, rolled back with everything else.
 execute $s$create schema net;
  create table net.sent(id bigint generated always as identity, url text, body jsonb, headers jsonb);
  create table net._http_response(id bigint, status_code integer, content text, timed_out boolean);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
   returns bigint language sql as 'insert into net.sent(url,body,headers) values(url,body,headers) returning id'$s$;
 perform vault.create_secret('https://push.example.invalid/api/push/dispatch','duty_push_url');
 perform pg_temp.check(duty_private.push_dispatch(now())=0,'no secret: nothing sent');
 perform vault.create_secret(repeat('s',40),'duty_push_secret');
 perform pg_temp.check(duty_private.push_dispatch(now())=1,'one batch');
 perform pg_temp.check((select status from public.duty_push_notifications where kind='swap_new' and params->>'request'='76000000-0000-0000-0000-0000000000b4')='skipped'
  and not exists(select 1 from public.duty_push_deliveries d join public.duty_push_notifications n on n.id=d.notification_id where n.params->>'request'='76000000-0000-0000-0000-0000000000b4'),'a cancelled ask is never sent');
 select id,net.sent.body into request,body from net.sent;
 perform pg_temp.check((select headers->>'Authorization' from net.sent)='Bearer '||repeat('s',40),'secret header');
 perform pg_temp.check(not body::text ~ 'private|@example','no notes, explanations or emails in the request');
 -- Tags are per notification (duty-<id>), never per kind: a new event of a kind the device
 -- already shows alerts again instead of silently replacing it.
 perform pg_temp.check((select bool_and(m->>'tag'='duty-'||d.notification_id) from jsonb_array_elements(body->'messages') m join public.duty_push_deliveries d on d.id=(m->>'id')::bigint)
  and exists(select 1 from jsonb_array_elements(body->'messages') a, jsonb_array_elements(body->'messages') b where a->>'kind'=b->>'kind' and a->>'tag'<>b->>'tag'),'one tag per notification');
 perform pg_temp.check((select count(*) from jsonb_array_elements(body->'messages') m where m->>'lang'='he')
  =(select count(*) from public.duty_push_deliveries d join public.duty_push_notifications n on n.id=d.notification_id where n.member_id='76000000-0000-0000-0000-000000000002'),'member 2''s language');
 perform pg_temp.check((select count(*) from public.duty_push_notifications where status='pending')=0,'every pending notification dispatched or skipped');
 perform pg_temp.check((select count(*) from public.duty_push_deliveries where status='sending' and request_id=request and attempts=1)=jsonb_array_length(body->'messages'),'one delivery per device, sending');
 perform pg_temp.check((select count(*) from public.duty_push_deliveries d join public.duty_push_notifications n on n.id=d.notification_id where n.member_id='76000000-0000-0000-0000-000000000002')
  =2*(select count(*) from public.duty_push_notifications where member_id='76000000-0000-0000-0000-000000000002' and status='dispatched'),'both of member 2''s devices');
 perform pg_temp.check(duty_private.push_dispatch(now())=0,'nothing sent twice');
 -- Outcomes: one sent, a device gone, one refused for now (retry), one rejected; the
 -- answer leaves the rest out, so they may have been sent: unknown, never resent.
 total:=jsonb_array_length(body->'messages');
 select min(d.id) filter (where s.endpoint like '%device-2a'),max(d.id) filter (where s.endpoint like '%device-2a'),
  min(d.id) filter (where s.endpoint like '%device-3'),min(d.id) filter (where s.endpoint like '%device-1')
 into sent_id,reject_id,gone_id,retry_id from public.duty_push_deliveries d join public.duty_push_subscriptions s on s.id=d.subscription_id;
 insert into net._http_response values(request,200,jsonb_build_object('results',jsonb_build_array(
  jsonb_build_object('id',sent_id::text,'outcome','sent','status',201),jsonb_build_object('id',gone_id::text,'outcome','gone','status',410),
  jsonb_build_object('id',retry_id::text,'outcome','retry','status',429),jsonb_build_object('id',reject_id::text,'outcome','rejected','status',400),
  jsonb_build_object('id','999999','outcome','sent')))::text,false);
 perform duty_private.push_reconcile(now());
 perform pg_temp.check((select status from public.duty_push_deliveries where id=sent_id)='sent'
  and (select sent_at is not null from public.duty_push_notifications n join public.duty_push_deliveries d on d.notification_id=n.id where d.id=sent_id),'sent');
 perform pg_temp.check((select status from public.duty_push_deliveries where id=gone_id)='gone'
  and not exists(select 1 from public.duty_push_subscriptions where endpoint like '%device-3'),'gone device forgotten');
 perform pg_temp.check((select status from public.duty_push_deliveries where id=retry_id)='failed','retry later');
 perform pg_temp.check((select status from public.duty_push_deliveries where id=reject_id)='rejected','rejected');
 perform pg_temp.check((select count(*) from public.duty_push_deliveries where status='unknown')=total-4,'unmentioned: never resent');
 -- Retries only after a backoff and at most three times; a refusal before sending is retried.
 perform pg_temp.check(duty_private.push_dispatch(now())=0,'backoff');
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '3 minutes')=1,'second attempt');
 select max(id) into request from net.sent;
 perform pg_temp.check(jsonb_array_length((select net.sent.body from net.sent where id=request)->'messages')=1,'only the refused delivery');
 insert into net._http_response values(request,503,'',false);
 perform duty_private.push_reconcile(now());
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '10 minutes')=1,'third attempt');
 select max(id) into request from net.sent;
 insert into net._http_response values(request,401,'',false);
 perform duty_private.push_reconcile(now());
 perform pg_temp.check((select status from public.duty_push_deliveries where id=retry_id)='abandoned','abandoned after three attempts');
 -- A timed-out request may have been delivered: unknown, never resent.
 perform pg_temp.check(duty_private.push_enqueue('76000000-0000-0000-0000-000000000001','test','fixture-timeout','{}','/?tab=schedule'),'one more');
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '20 minutes')=1,'sent');
 select max(id) into request from net.sent;
 insert into net._http_response values(request,null,null,true);
 perform duty_private.push_reconcile(now());
 perform pg_temp.check((select status from public.duty_push_deliveries where request_id=request)='unknown','timed out');
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '30 minutes')=0,'never resent');
 -- A shared phone: a delivery still waiting for member 2 is never sent once the device
 -- belongs to member 3; it is abandoned instead.
 insert into public.duty_push_notifications(member_id,kind,dedupe_key,url,status)
 values('76000000-0000-0000-0000-000000000002','test','fixture-moved','/?tab=schedule','dispatched') returning id into moved;
 insert into public.duty_push_deliveries(notification_id,subscription_id) select moved,id from public.duty_push_subscriptions where endpoint like '%device-2a';
 update public.duty_push_subscriptions set member_id='76000000-0000-0000-0000-000000000003' where endpoint like '%device-2a';
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '40 minutes')=0,'moved device: nothing sent');
 perform duty_private.push_reconcile(now());
 perform pg_temp.check((select status from public.duty_push_deliveries where notification_id=moved)='abandoned','moved device: abandoned');
 -- Idle: nothing due means no secret read and no HTTP request.
 total:=(select count(*) from net.sent);
 perform pg_temp.check(duty_private.push_dispatch(now()+interval '50 minutes')=0 and (select count(*) from net.sent)=total,'idle: no HTTP request');
 -- Event alerts do not wait for the clock: at commit (here: constraints made immediate)
 -- the transaction's alerts go out in one request.
 perform pg_temp.check(duty_private.push_enqueue('76000000-0000-0000-0000-000000000001','test','fixture-immediate','{}','/?tab=schedule'),'an event alert');
 perform pg_temp.check((select count(*) from net.sent)=total,'not before commit');
 execute 'set constraints duty_push_dispatch_now immediate';
 perform pg_temp.check((select count(*) from net.sent)=total+1 and (select status from public.duty_push_notifications where dedupe_key='fixture-immediate')='dispatched','sent at commit');
 -- The tick runs everything and skips when another run holds the lock.
 perform pg_temp.check(duty_private.push_tick() ? 'scheduled','tick');
end$$;
rollback;

-- Read-only display projection. Due and future published work is simulated on
-- a private copy; nothing is appended and the workspace revision never changes.
-- Members receive only their own relationships; audit events/reasons never leave.
CREATE FUNCTION duty_private.balance() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare me text; manager boolean; actual jsonb; projected jsonb; instant bigint; lines jsonb; net jsonb;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 me:=auth.uid()::text; manager:=duty_private.is_manager();
 actual:=duty_private.compensation_state();
 instant:=greatest(duty_private.compensation_now(),coalesce((actual->'events'->-1->>'at')::bigint,0));
 actual:=duty_private.compensation_reconcile(actual,instant,false);
 projected:=duty_private.compensation_reconcile(actual,9007199254740991,false);
 with source as (
  -- Open actual relationships, described by their originating lot.
  select c->>'debtorId' debtor,c->>'creditorId' creditor,(c->>'units')::bigint units,
   case when jsonb_array_length(c->'path')>1 then 'routed'
    when lot ? 'correctionOf' then 'correction'
    -- A server-compiled allocation intent leg whose first counterpart is system uneven-month credit.
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/allocation/') and starts_with(coalesce(actual->'intents'->regexp_replace(substr(lot->>'id',length(lot->>'sourceKey')+9),'/route/[0-9]+$','')
     ->'route'->(substring(lot->>'id' from '/route/([0-9]+)$')::integer)->'transferIds'->>0,''),'uneven/') then 'uneven'
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/') then 'temporary'
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/transfer/') then 'change'
    when lot->>'sourceKey' like 'manual/%' then 'manual' else 'other' end kind,
   case when jsonb_array_length(c->'path')=1 and starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/') then
    (select min(p->>'date') from jsonb_array_elements(actual->'intents'->regexp_replace(substr(lot->>'id',length(lot->>'sourceKey')+9),'/route/[0-9]+$','')->'capacity') p) end AS day,
   case when jsonb_array_length(c->'path')=1 and starts_with(lot->>'id',(lot->>'sourceKey')||'/transfer/') then
    (select e->'operation'->>'month' from jsonb_array_elements(actual->'events') e where e->>'sourceKey'=lot->>'sourceKey' limit 1) end AS month
  from jsonb_array_elements(actual->'claims') c cross join lateral (select actual->'lots'->(c->'path'->0->>'lotId') lot) l
  union all
  -- Published repayments that settle only in the projection.
  select r->'claim'->>'debtorId',r->'claim'->>'creditorId',-(r->>'units')::bigint,'repayment',
   projected->'contributions'->(r->>'contributionId')->'capacity'->>'date',null
  from jsonb_each(projected->'settlements') x(id,r) where not (actual->'settlements' ? x.id) and r ? 'contributionId'
 ), side as (
  select creditor member,debtor counterpart,units,kind,day,month from source
  union all select debtor,creditor,-units,kind,day,month from source
 ), visible as (
  select * from side where manager or member=me
 ), relationship as (
  select member,counterpart from visible group by member,counterpart having sum(units)<>0
 )
 select coalesce(jsonb_agg(jsonb_build_object('memberId',v.member,'counterpartId',v.counterpart,'units',v.units,'kind',v.kind,'date',v.day,'month',v.month)
  order by v.member COLLATE "C",v.counterpart COLLATE "C",coalesce(v.day,v.month) COLLATE "C" nulls first,v.kind COLLATE "C",v.units),'[]')
 into lines from visible v join relationship o using(member,counterpart);
 net:=coalesce((select jsonb_object_agg(m.key,coalesce((select sum(case when c->>'creditorId'=m.key then (c->>'units')::bigint else -(c->>'units')::bigint end)
  from jsonb_array_elements(projected->'claims') c where m.key in (c->>'debtorId',c->>'creditorId')),0))
  from jsonb_each(projected->'members') m where manager or m.key=me),'{}');
 return jsonb_build_object('net',net,'lines',lines);
end $$;

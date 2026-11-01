-- The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
-- month's publication events booked is reversed by an audited correction, then a current
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- A month whose only version was deleted still has live lots: a new plan reverses them
-- too, so they are never counted twice. Keys carry the ledger position, so the month can
-- be re-planned again later. Refused when a repayment of another month already uses one
-- of those lots, or would be held because a debt it repays nets differently afterwards
-- (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the published month has started (review-replan-started), its
-- last version counting when the only one was deleted: worked days keep their debts.
-- `commit` appends the events for real, inside the publishing transaction.
-- lib/compensation/replan.ts builds the same events.
CREATE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb:=s; pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:='Re-planned '||p_month;
 last jsonb:=coalesce(s->'publications'->p_month,(select x->'operation'->'after' from jsonb_array_elements(s->'events') with ordinality e(x,i)
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month and x->'operation'->'after'<>'null' order by i desc limit 1));
 prefix text:='replan/'||coalesce(s->'publications'->p_month->>'id','none')||'/'||coalesce((s->'events'->-1->>'sequence')::bigint,0)||'/';
begin
 if last is not null and exists(select 1 from jsonb_each(duty_private.compensation_atoms(last)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
 select coalesce(array_agg(x->>'sourceKey'),'{}') into keys from jsonb_array_elements(s->'events') x
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 select coalesce(array_agg(l.key order by l.key COLLATE "C"),'{}') into lots from jsonb_each(s->'lots') l
  where l.value->>'sourceKey'=any(keys) and (l.value->>'correctedUnits')::bigint>0;
 for c in select value from jsonb_each(s->'contributions') where value->>'status'<>'cancelled'
  and exists(select 1 from jsonb_array_elements(value->'claim'->'path') p where p->>'lotId'=any(lots)) loop
  if pub is not null and exists(select 1 from jsonb_array_elements(pub->'reservations') r where r->>'id'=c->>'id') then
   if c->>'status'='settled' then raise exception 'review-replan-started'; end if;
   continue;
  end if;
  -- The earliest other month whose repayment uses this month's points.
  other:=least(other,coalesce((select min(m.key COLLATE "C") from jsonb_each(s->'publications') m
   where exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=c->>'id')),'unknown'));
 end loop;
 if other is not null then raise exception 'review-replan-later:%',other; end if;
 foreach key in array lots loop
  lot:=s->'lots'->key;
  if (lot->>'remaining')::bigint<(lot->>'units')::bigint then raise exception 'review-replan-settled'; end if;
  op:=jsonb_build_object('kind','correct','lotId',key,'deltaUnits',-(lot->>'correctedUnits')::bigint);
  s:=duty_private.compensation_replan_step(s,op,prefix||key,instant,actor,reason,commit);
 end loop;
 if pub is not null then
  op:=jsonb_build_object('kind','publication','month',p_month,'beforeId',pub->'id','after',null,'mode','delete');
  s:=duty_private.compensation_replan_step(s,op,prefix||'delete',instant,actor,null,commit);
 end if;
 -- Reversing the lots changes how debts net: another month's pending repayment on a debt
 -- that changed would be held and never settle. That month is changed first.
 select min(coalesce((select min(m.key COLLATE "C") from jsonb_each(original->'publications') m where m.key<>p_month
   and exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=held.key)),'unknown') COLLATE "C") into other
  from jsonb_each(original->'contributions') held where held.value->>'status'='pending'
   and s->'contributions'->held.key->>'status'='held' and s->'contributions'->held.key->>'holdReason'='claim-changed';
 if other is not null then raise exception 'review-replan-later:%',other; end if;
 return s;
end $$;

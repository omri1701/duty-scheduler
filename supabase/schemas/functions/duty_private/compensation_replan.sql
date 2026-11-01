-- The ledger a new plan for a published month starts from (decision 2026-11-01): every
-- lot the month's publications booked is reversed by an audited correction, then the
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- Refused when a repayment of another month already uses one of those lots
-- (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the month has started (review-replan-started).
-- `commit` appends the events for real, inside the publishing transaction.
-- lib/compensation/replan.ts builds the same events.
CREATE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:='Re-planned '||p_month;
begin
 if pub is null then return s; end if;
 if exists(select 1 from jsonb_each(duty_private.compensation_atoms(pub)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
 select coalesce(array_agg(x->>'sourceKey'),'{}') into keys from jsonb_array_elements(s->'events') x
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 select coalesce(array_agg(l.key order by l.key COLLATE "C"),'{}') into lots from jsonb_each(s->'lots') l where l.value->>'sourceKey'=any(keys);
 for c in select value from jsonb_each(s->'contributions') where value->>'status'<>'cancelled'
  and exists(select 1 from jsonb_array_elements(value->'claim'->'path') p where p->>'lotId'=any(lots)) loop
  if exists(select 1 from jsonb_array_elements(pub->'reservations') r where r->>'id'=c->>'id') then
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
  if (lot->>'correctedUnits')::bigint=0 then continue; end if;
  op:=jsonb_build_object('kind','correct','lotId',key,'deltaUnits',-(lot->>'correctedUnits')::bigint);
  s:=duty_private.compensation_replan_step(s,op,'replan/'||(pub->>'id')||'/'||key,instant,actor,reason,commit);
 end loop;
 op:=jsonb_build_object('kind','publication','month',p_month,'beforeId',pub->'id','after',null,'mode','delete');
 return duty_private.compensation_replan_step(s,op,'replan/'||(pub->>'id')||'/delete',instant,actor,null,commit);
end $$;


-- A repayment left held because the debt it repays changed (claim-changed) never silently
-- counts for nothing (decision 2026-11-07): every pending repayment of `before` that the events
-- since left held is released, and the work it planned is booked once as an ordinary debt the
-- other way (the repaid creditor owes the debtor who does it), audited with `reason`. Keys
-- `<prefix>release/<repayment>` and `<prefix>reverse/<repayment>`; the reverse debt belongs to
-- the month that planned the repayment (compensation_replan reverses it with that month).
-- lib/compensation/replan.ts (releaseHeld) builds the same events.
CREATE FUNCTION duty_private.compensation_release_held(before jsonb, s jsonb, prefix text, instant bigint, actor text, reason text, commit boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare c record;
begin
 for c in select key,value from jsonb_each(s->'contributions') where value->>'status'='held' and value->>'holdReason'='claim-changed'
  and before->'contributions'->key->>'status'='pending' order by key COLLATE "C" loop
  s:=duty_private.compensation_replan_step(s,jsonb_build_object('kind','release','contributionId',c.key),prefix||'release/'||c.key,instant,actor,reason,commit);
  s:=duty_private.compensation_replan_step(s,jsonb_build_object('kind','claim','debtorId',c.value->'claim'->'creditorId','creditorId',c.value->'claim'->'debtorId',
   'units',c.value->'capacity'->'units'),prefix||'reverse/'||c.key,instant,actor,reason,commit);
 end loop;
 return s;
end $$;

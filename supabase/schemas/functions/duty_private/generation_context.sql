-- Also used inside checked writes, after taking the shared revision lock.
CREATE FUNCTION duty_private.generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare s jsonb; before_count integer; instant bigint; opening bigint; facts jsonb; projected jsonb; planned jsonb; blocked text;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 instant:=duty_private.compensation_now();
 s:=duty_private.compensation_state(); before_count:=jsonb_array_length(s->'events');
 s:=duty_private.compensation_reconcile(s,greatest(instant,coalesce((s->'events'->-1->>'at')::bigint,0)));
 if before_count<>jsonb_array_length(s->'events') then update public.duty_workspace set revision=revision+1 where id; end if;
 facts:=duty_private.generation_facts(p_month);
 opening:=(extract(epoch from (((facts->'duties'->0->>'startDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
 -- A published month is planned from the ledger without its own entries (decision
 -- 2026-11-01): its booked lots reversed and its publication deleted, as publishing a new
 -- plan will do. `replanBlocked` names why that is impossible; the plan then shows the ledger.
 planned:=s;
 if s->'publications' ? p_month then
  begin planned:=duty_private.compensation_replan(s,p_month,greatest(instant,coalesce((s->'events'->-1->>'at')::bigint,0)));
  exception when raise_exception then if SQLERRM not like 'review-replan-%' then raise; end if; blocked:=SQLERRM;
  end;
 end if;
 projected:=duty_private.compensation_reconcile(planned,greatest(instant,opening,coalesce((planned->'events'->-1->>'at')::bigint,0)),false);
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'coverageStartMs',opening,
  'generationAllowed',instant<opening,'facts',facts,'actual',duty_private.compensation_view(planned),'projected',duty_private.compensation_view(projected),
  'accountingFingerprint',md5((s->'events')::text),'fingerprint',md5(facts::text||(s->'events')::text))
  ||case when s->'publications' ? p_month then jsonb_build_object('replanBlocked',blocked) else '{}'::jsonb end;
end $$;

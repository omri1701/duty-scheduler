-- Also used inside checked writes, after taking the shared revision lock.
CREATE FUNCTION duty_private.generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare s jsonb; before_count integer; instant bigint; opening bigint; facts jsonb; projected jsonb;
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
 projected:=duty_private.compensation_reconcile(s,greatest(instant,opening),false);
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'coverageStartMs',opening,
  'generationAllowed',instant<opening,'facts',facts,'actual',duty_private.compensation_view(s),'projected',duty_private.compensation_view(projected),
  'accountingFingerprint',md5((s->'events')::text),'fingerprint',md5(facts::text||(s->'events')::text));
end $$;

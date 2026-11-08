CREATE FUNCTION duty_private.compensation(p_operation jsonb, p_source_key text, p_reason text, p_revision bigint, p_fingerprint text DEFAULT NULL, p_cutoff bigint DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; projected jsonb; instant bigint; first_count bigint; key text; previous public.duty_compensation_events; allowed text[]; kind text:=p_operation->>'kind';
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform 1 from public.duty_workspace where id for update;
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_operation) IS DISTINCT FROM 'object' or length(p_operation::text)>100000 or kind is null then raise exception 'Invalid compensation operation'; end if;
 case kind
 when 'claim' then allowed:=array['kind','debtorId','creditorId','units'];
 when 'adjust' then allowed:=array['kind','claim','units','mode'];
 when 'correct' then allowed:=array['kind','lotId','deltaUnits'];
 when 'reverse-settlement' then allowed:=array['kind','settlementId'];
 when 'release' then allowed:=array['kind','contributionId'];
 when 'reconcile' then allowed:=array['kind'];
 else raise exception 'Invalid compensation operation';
 end case;
 if p_operation-allowed<>'{}' then raise exception 'Invalid compensation fields'; end if;
 if kind<>'reconcile' then
  if p_source_key is null or p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$' or coalesce(btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'')='' or length(p_reason)>2000 then raise exception 'Source key and reason required'; end if;
  key:='manual/'||auth.uid()::text||'/'||p_source_key;
  select * into previous from public.duty_compensation_events where source_key=key;
  if found and (previous.operation<>p_operation or previous.reason is distinct from p_reason or previous.actor<>auth.uid()::text) then raise exception 'source-key-conflict'; end if;
 end if;
 -- An identical authorized retry may carry its original revision. It cannot
 -- write a second discretionary event or apply changed content under that key.
 if previous.sequence is null then perform duty_private.check_revision(p_revision); end if;
 s:=duty_private.compensation_state(); first_count:=jsonb_array_length(s->'events');
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 if previous.sequence is null and p_fingerprint is not null and p_fingerprint<>md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
 if kind<>'reconcile' then s:=duty_private.compensation_append(s,p_operation,key,instant,auth.uid()::text,p_reason); end if;
 if jsonb_array_length(s->'events')<>first_count then update public.duty_workspace set revision=revision+1 where id; end if;
 if p_cutoff is not null then
  if p_cutoff<instant or p_cutoff>9007199254740991 then raise exception 'projection-before-now'; end if;
  projected:=duty_private.compensation_view(duty_private.compensation_reconcile(s,p_cutoff,false));
 end if;
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'cutoffMs',p_cutoff,
  'fingerprint',md5((s->'events')::text),'actual',duty_private.compensation_view(s),
  'projected',case when projected is not null then jsonb_build_object('claims',projected->'claims','net',projected->'net') end);
end $$;

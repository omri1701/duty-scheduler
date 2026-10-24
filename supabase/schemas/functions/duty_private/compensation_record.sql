-- Internal fact writer. All call sites already hold the workspace lock; take it
-- here too so migrations/triggers have the same ordering and post-lock clock.
CREATE FUNCTION duty_private.compensation_record(op jsonb, key text, reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; instant bigint;
begin
 perform 1 from public.duty_workspace where id for update;
 s:=duty_private.compensation_state();
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 return duty_private.compensation_append(s,op,key,instant,coalesce(auth.uid()::text,'system'),reason);
end $$;

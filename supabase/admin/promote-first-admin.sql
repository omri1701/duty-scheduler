-- Operator-only, after confirming the project ref and the owner's actual Google auth UUID.
-- psql -v ON_ERROR_STOP=1 -v auth_user_id=<verified-uuid> -f supabase/admin/promote-first-admin.sql
-- With MCP: substitute the UUID into SET LOCAL, preserving the transaction and every check.
BEGIN;
SET LOCAL duty.bootstrap_user_id = :'auth_user_id';
DO $bootstrap$
DECLARE
  target uuid := current_setting('duty.bootstrap_user_id')::uuid;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Trusted database operator required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.duty_workspace WHERE id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace has not been initialized'; END IF;
  IF EXISTS (SELECT 1 FROM public.duty_members m JOIN public.duty_roles r ON r.code=m.role WHERE r.can_manage) THEN
    RAISE EXCEPTION 'First-admin bootstrap already completed; use the checked role RPC';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u JOIN auth.identities i ON i.user_id=u.id
    JOIN public.duty_members m ON m.id=u.id
    WHERE u.id=target AND u.email_confirmed_at IS NOT NULL AND NOT u.is_anonymous
      AND i.provider='google' AND lower(u.email)=m.email
      AND m.role='engineer' AND m.status='pending' AND NOT m.active
  ) THEN RAISE EXCEPTION 'Expected the verified Google account with its pending onboarded profile'; END IF;
  UPDATE public.duty_members SET role='admin',status='approved',active=true WHERE id=target;
  UPDATE public.duty_workspace SET revision=revision+1 WHERE id;
END
$bootstrap$;
COMMIT;

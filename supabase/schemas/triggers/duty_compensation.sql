-- AFTER INSERT excludes INSERT ... ON CONFLICT DO NOTHING retries. Updates run
-- BEFORE the participation change so earned work is reconciled before a freeze.
CREATE TRIGGER duty_compensation_member_insert AFTER INSERT ON public.duty_members
 FOR EACH ROW EXECUTE FUNCTION duty_private.compensation_members();
CREATE TRIGGER duty_compensation_member_update BEFORE UPDATE OF active,status ON public.duty_members
 FOR EACH ROW EXECUTE FUNCTION duty_private.compensation_members();
CREATE TRIGGER duty_compensation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.duty_compensation_events
 FOR EACH STATEMENT EXECUTE FUNCTION duty_private.compensation_immutable();

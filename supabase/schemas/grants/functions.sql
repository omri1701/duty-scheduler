REVOKE ALL ON FUNCTION duty_private.assert_admin_remains() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.check_revision(p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.current_duties() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.duty_owner(p_day date) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.is_manager() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_manager() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.is_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_member() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.join_team(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.join_team(p_name text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.reconcile_publication_swaps() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.reconcile_swaps(p_month text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.validate_swap(p_from uuid, p_to uuid, p_publication uuid, p_override boolean) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_join(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_load() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_load() TO authenticated;
GRANT ALL ON FUNCTION public.duty_load() TO service_role;

REVOKE ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO service_role;

-- Versions names the versions a re-plan reversed before the click (decision 2026-11-01):
-- restoring one, or deleting the live version when that would bring one back, was only
-- refused after Confirm. duty_replanned_versions returns those versions' ids to admins so
-- the dialog disables the buttons with a note; restore and delete still refuse them.
-- The month's versions a re-plan reversed (decision 2026-11-01), so Versions disables
-- restoring them, and deleting the live version when that would bring one back, before
-- the click. Admin-only and read-only: ids of publications admins already see.
CREATE FUNCTION duty_private.replanned_versions(p_month text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare s jsonb;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 s:=duty_private.compensation_state();
 return coalesce((select jsonb_agg(p.id order by p.version) from public.duty_publications p
  where p.month=p_month and duty_private.compensation_replanned(s,p.month,p.id)),'[]'::jsonb);
end $$;

CREATE FUNCTION public.duty_replanned_versions(p_month text) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.replanned_versions(p_month);
$$;

REVOKE ALL ON FUNCTION duty_private.replanned_versions(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.replanned_versions(text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_replanned_versions(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_replanned_versions(text) TO authenticated;

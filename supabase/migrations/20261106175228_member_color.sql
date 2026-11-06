-- Each member picks their own calendar colour in Settings (decision 2026-11-06): one own-row
-- checked RPC, like duty_rename_self. The colour column and its #rrggbb check already exist;
-- admins keep changing anyone's colour through duty_save_schedule's team rows.

-- Source: schemas/functions/duty_private/set_color.sql
-- The caller's own calendar colour (decision 2026-11-06): any #rrggbb, chosen from the app's
-- palette in Settings. Everyone sees it, so it takes the workspace revision like a rename.
CREATE FUNCTION duty_private.set_color(p_color text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform duty_private.check_revision(p_revision);
 if p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Choose a colour from the palette'; end if;
 update public.duty_members set color=lower(p_color) where id=auth.uid();
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/public/duty_set_color.sql
CREATE FUNCTION public.duty_set_color(p_color text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_color(p_color,p_revision)$$;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.set_color(p_color text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_color(p_color text, p_revision bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_set_color(p_color text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_color(p_color text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_color(p_color text, p_revision bigint) TO service_role;

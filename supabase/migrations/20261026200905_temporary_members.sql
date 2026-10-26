-- Expand member identity without changing existing member IDs or referencing history.
ALTER TABLE public.duty_members
 ADD COLUMN is_temporary boolean DEFAULT false NOT NULL,
 ADD COLUMN auth_user_id uuid GENERATED ALWAYS AS (CASE WHEN is_temporary THEN NULL::uuid ELSE id END) STORED,
 ALTER COLUMN email DROP NOT NULL,
 DROP CONSTRAINT duty_members_id_fkey,
 ADD CONSTRAINT duty_members_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
 ADD CONSTRAINT duty_members_identity_check CHECK ((is_temporary AND email IS NULL AND role = 'engineer' AND status = 'approved') OR (NOT is_temporary AND email IS NOT NULL));

CREATE OR REPLACE FUNCTION duty_private.is_manager() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select auth.uid() is not null and exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role where m.auth_user_id=auth.uid() and r.can_manage and m.status='approved' and m.active)
$$;

CREATE OR REPLACE FUNCTION duty_private.is_member() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select auth.uid() is not null and exists(select 1 from public.duty_members where auth_user_id=auth.uid() and status='approved' and active)
$$;

CREATE OR REPLACE FUNCTION duty_private.add_temporary_member(p_name text, p_revision bigint) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare member_id uuid := gen_random_uuid();
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 insert into public.duty_members(id,name,is_temporary,status,active,seniority,color)
 values(member_id,trim(p_name),true,'approved',true,
  (select coalesce(max(seniority),0)+1 from public.duty_members),
  (array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9'])[(select count(*)::int%12+1 from public.duty_members)]);
 update public.duty_workspace set revision=revision+1 where id;
 return member_id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.rename_temporary_member(p_member uuid, p_name text, p_revision bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 update public.duty_members set name=trim(p_name) where id=p_member and is_temporary;
 if not found then raise exception 'Temporary member required'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION public.duty_add_temporary_member(p_name text, p_revision bigint) RETURNS uuid
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.add_temporary_member(p_name,p_revision)$$;

CREATE OR REPLACE FUNCTION public.duty_rename_temporary_member(p_member uuid, p_name text, p_revision bigint) RETURNS void
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.rename_temporary_member(p_member,p_name,p_revision)$$;

REVOKE ALL ON FUNCTION duty_private.add_temporary_member(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.add_temporary_member(text, bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.rename_temporary_member(uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.rename_temporary_member(uuid, text, bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_add_temporary_member(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_add_temporary_member(text, bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_rename_temporary_member(uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_rename_temporary_member(uuid, text, bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';

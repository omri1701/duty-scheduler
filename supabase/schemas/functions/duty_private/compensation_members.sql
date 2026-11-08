CREATE FUNCTION duty_private.compensation_members() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
begin
 if TG_OP='UPDATE' and (old.active and old.status='approved')=(new.active and new.status='approved') then return new; end if;
 -- Updates run BEFORE the row changes: due work earns under the old state.
 -- The pending member created by onboarding has zero balance and no authority.
 perform duty_private.compensation_record(jsonb_build_object('kind','members','members',jsonb_build_array(
  jsonb_build_object('id',new.id,'active',new.active and new.status='approved'))),'members/'||gen_random_uuid());
 return new;
end $$;

CREATE FUNCTION public.duty_load() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
 select jsonb_build_object(
 'revision',(select revision from public.duty_workspace where id),
 'members',coalesce((select jsonb_agg(to_jsonb(m) order by seniority,joined_at) from public.duty_members m),'[]'::jsonb),
 'months',coalesce((select jsonb_agg(to_jsonb(m)) from public.duty_months m),'[]'::jsonb),
 'constraints',coalesce((select jsonb_agg(to_jsonb(c)) from public.duty_constraints c),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a),'[]'::jsonb),
 'publications',coalesce((select jsonb_agg(to_jsonb(p) order by month,version desc) from public.duty_publications p),'[]'::jsonb),
 'roles',(select jsonb_agg(to_jsonb(r) order by code) from public.duty_roles r),
 'memberStatuses',(select jsonb_agg(to_jsonb(s) order by code) from public.duty_member_statuses s),
 'monthStatuses',(select jsonb_agg(to_jsonb(s) order by code) from public.duty_month_statuses s),
 'constraintTypes',(select jsonb_agg(to_jsonb(c) order by code) from public.duty_constraint_types c),
 'swapRequests',coalesce((select jsonb_agg(to_jsonb(s) order by created_at desc,id) from public.duty_swap_requests s),'[]'::jsonb))
$$;

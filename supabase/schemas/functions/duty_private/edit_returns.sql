-- Who a Permanent edit of this published duty would return it to as an undo (rule H1,
-- decision 2026-11-06): the engineers who held it before a Temporary change still in
-- effect, most recent first. Replays the duty's version lineage forward: a Temporary edit
-- (only this duty changed hands, no new intent) adds its previous holder; a return to one
-- of them (a Temporary `edit/` intent) drops the undone changes; a swap, a Permanent edit,
-- a plan or any other change starts again. Versions restored by deletion keep the chain of
-- the version they restore. Manager only; nothing leaves but member ids.
CREATE FUNCTION duty_private.edit_returns(p_publication uuid, p_day date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m text; target text:=p_publication::text; seq bigint; op jsonb; prior jsonb;
 lineage jsonb:='[]'; step jsonb; holder text; previous text; chain jsonb:='[]'; intent jsonb; k integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into d from public.duty_assignments where publication_id=p_publication and day=p_day;
 if d.id is null or d.primary_id is null then return chain; end if;
 m:=duty_private.duty_owner(d.day);
 -- Back to the month's first version or its latest plan, newest first.
 loop
  select e.sequence,e.operation into seq,op from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m
   and not (e.operation ? 'mode') and e.operation->'after'->>'id'=target and (seq is null or e.sequence<seq) order by e.sequence desc limit 1;
  exit when not found or op->>'beforeId' is null;
  select e.operation into prior from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m
   and not (e.operation ? 'mode') and e.operation->'after'->>'id'=op->>'beforeId' and e.sequence<seq order by e.sequence desc limit 1;
  exit when prior is null;
  lineage:=jsonb_build_array(jsonb_build_object('before',prior->'after','after',op->'after'))||lineage;
  target:=op->>'beforeId';
 end loop;
 for step in select value from jsonb_array_elements(lineage) with ordinality o(value,n) order by n loop
  select x->>'primaryId' into previous from jsonb_array_elements(step->'before'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
  select x->>'primaryId' into holder from jsonb_array_elements(step->'after'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
  if previous is null or holder is null then chain:='[]'; continue; end if;
  if previous=holder then continue; end if;
  select i into intent from jsonb_array_elements(step->'after'->'intents') i
   where not coalesce(step->'before'->'intents' @> jsonb_build_array(jsonb_build_object('id',i->>'id')),false)
    and exists(select 1 from jsonb_array_elements(i->'capacity') c where (c->>'date')::date>=d.day and (c->>'date')::date<d.end_day) limit 1;
  if intent is not null then
   -- A return to an earlier holder undoes the changes after it; anything else starts again.
   select max(n) into k from jsonb_array_elements_text(chain) with ordinality o(v,n) where v=holder;
   chain:=case when intent->>'kind'='temporary' and starts_with(intent->>'id','edit/') and intent->'route' is null and k is not null
    then coalesce((select jsonb_agg(v order by n) from jsonb_array_elements_text(chain) with ordinality o(v,n) where n<k),'[]') else '[]' end;
  elsif (select count(*) from jsonb_array_elements(step->'after'->'duties') x where not exists(select 1 from jsonb_array_elements(step->'before'->'duties') y
    where y->>'startDate'=x->>'startDate' and y->>'endDate'=x->>'endDate' and y->>'primaryId'=x->>'primaryId'))=1 then
   chain:=chain||to_jsonb(previous);
  else chain:='[]';
  end if;
 end loop;
 -- Most recent first; only engineers who can still take the duty.
 return coalesce((select jsonb_agg(v order by n desc) from jsonb_array_elements_text(chain) with ordinality o(v,n)
  where exists(select 1 from public.duty_members where id::text=v and active and status='approved')),'[]');
end $$;

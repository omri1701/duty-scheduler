-- Republishing a restored/generated arrangement never replays old origins.
-- Carried reservations retain their IDs; still-outstanding cancelled plans can
-- bind new real capacity using fresh IDs and the retained source publication.
CREATE FUNCTION duty_private.allocation_rebind(s jsonb, publication jsonb, source_publication uuid, allocation_id uuid, instant bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb; r jsonb; c jsonb; e jsonb; after_state jsonb; finish jsonb; excluded jsonb; reservations jsonb:=publication->'reservations';
 atoms jsonb; day text; a jsonb; cell bigint; remaining bigint; off bigint; ref jsonb; key text; wanted bigint[]; position integer;
begin
 select x->'operation'->'after' into original from jsonb_array_elements(s->'events') x where x->'operation'->'after'->>'id'=source_publication::text limit 1;
 if original is null then raise exception 'Review missing allocation publication lineage'; end if;
 e:=jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey','publication/'||(publication->>'id')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),'at',instant,
  'actor',coalesce(auth.uid()::text,'system'),'operation',jsonb_build_object('kind','publication','month',publication->'month','beforeId',s->'publications'->(publication->>'month')->'id','after',publication));
 finish:=duty_private.compensation_transition(s,e); excluded:=finish->'excluded'; atoms:=finish->'atoms';
 after_state:=duty_private.compensation_apply(s,e);
 for r in select value from jsonb_array_elements(reservations) loop excluded:=duty_private.compensation_exclude(excluded,r->'capacity'); end loop;
 for r in select value from jsonb_array_elements(original->'reservations') order by value->>'id' COLLATE "C" loop
  c:=after_state->'contributions'->(r->>'id');
  if c->>'status'='settled' or exists(select 1 from jsonb_array_elements(reservations) kept where kept->>'id'=r->>'id') then continue; end if;
  wanted:='{}';
  for off in 0..(r->'capacity'->>'units')::bigint-1 loop
   ref:=duty_private.compensation_slice(r->'claim',1,off);
   -- Historical ancestors may already have carried or earned descendants with
   -- different IDs. Compare original source slices, not contribution IDs.
   if exists(select 1 from jsonb_each(after_state->'contributions') child where
    (child.value->>'status'='settled' or (child.value->>'status' in ('pending','held') and exists(select 1 from jsonb_array_elements(reservations) kept where kept->>'id'=child.key)))
    and duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(duty_private.compensation_segment(child.value->'claim','{"at":0,"sequence":0,"lotId":"lineage"}'))),ref) is not null) then continue; end if;
   -- Explicit manager release is not an invitation to reserve the same work
   -- again through an older publication's metadata.
   if exists(select 1 from jsonb_array_elements(s->'events') released join jsonb_each(s->'contributions') child on child.key=released->'operation'->>'contributionId'
    where released->'operation'->>'kind'='release' and duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(
     duty_private.compensation_segment(child.value->'claim','{"at":0,"sequence":0,"lotId":"lineage"}'))),ref) is not null) then raise exception 'Repayment lineage changed. Refresh and review.' using errcode='40001'; end if;
   if duty_private.compensation_locate(jsonb_build_object('claims',duty_private.compensation_candidates(after_state)),ref) is null then raise exception 'Repayment lineage changed. Refresh and review.' using errcode='40001'; end if;
   wanted:=array_append(wanted,off);
  end loop;
  remaining:=cardinality(wanted); position:=1;
  for day,a in select * from jsonb_each(atoms) where value->>'primaryId'=r->'claim'->>'debtorId' order by key loop
   if (a->>'endInstantMs')::bigint<=instant then continue; end if;
   for cell in 0..(a->>'units')::bigint-1 loop
    if remaining=0 then exit; end if;
    if coalesce(excluded->day,'[]') @> jsonb_build_array(cell) then continue; end if;
    off:=wanted[position]; key:='allocation/'||allocation_id||'/rebind/'||md5((publication->>'id')||'/'||(r->>'id')||'/'||off);
    ref:=duty_private.compensation_slice(r->'claim',1,off);
    reservations:=reservations||jsonb_build_array(jsonb_build_object('id',key,'capacity',jsonb_build_object('date',day,'offset',cell,'units',1),'claim',ref));
    excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1));
    -- Reserve selected source units in the preview too, so later plans cannot
    -- borrow a prefix already earmarked by this operation.
    after_state:=jsonb_set(after_state,array['contributions',key],jsonb_build_object('id',key,'claim',ref,'status','pending'));
    remaining:=remaining-1; position:=position+1;
   end loop;
  end loop;
  if remaining<>0 then raise exception 'Repayment capacity changed. Refresh and review.' using errcode='40001'; end if;
 end loop;
 return jsonb_build_object('fingerprint',md5((s->'events')::text),'intents',publication->'intents','reservations',reservations);
end $$;

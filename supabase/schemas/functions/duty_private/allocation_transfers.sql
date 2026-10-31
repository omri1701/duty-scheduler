-- The canonical transfer list of a per-person allocation state, kind by kind
-- (permanent first): explicit pairs in order, clipped to the net changes they
-- can still route, then the remainder netted largest first, then seniority
-- order, each side advancing only when exhausted. One transfer per direction;
-- round trips cancel in the nets. lib/allocation/derive.ts deriveTransfers is
-- the same derivation; duty_confirm_allocation requires the client's list to
-- equal this one, so no transfer list can manufacture relief the nets do not show.
CREATE FUNCTION duty_private.allocation_transfers(seniority jsonb, changes jsonb, pairs jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare kind text; remaining jsonb; flows jsonb; result jsonb:='[]'; p jsonb; u bigint; idx integer; id text;
 debtors text[]; creditors text[]; d_units bigint[]; c_units bigint[]; d integer; c integer; from_id text; to_id text;
begin
 foreach kind in array array['permanent','temporary'] loop
  remaining:='{}'; flows:='[]';
  for id in select jsonb_array_elements_text(seniority) loop remaining:=remaining||jsonb_build_object(id,coalesce((changes->id->>kind)::numeric::bigint,0)); end loop;
  for p in select value from jsonb_array_elements(pairs) where value->>'kind'=kind loop
   from_id:=p->>'fromId'; to_id:=p->>'toId';
   if from_id is null or to_id is null or not remaining ? from_id or not remaining ? to_id or from_id=to_id then continue; end if;
   u:=least((p->>'units')::numeric::bigint,greatest(0,-(remaining->>from_id)::bigint),greatest(0,(remaining->>to_id)::bigint));
   if u<=0 then continue; end if;
   select i::integer-1 into idx from jsonb_array_elements(flows) with ordinality a(v,i) where v->>'fromId'=from_id and v->>'toId'=to_id;
   if idx is null then flows:=flows||jsonb_build_array(jsonb_build_object('id',kind||'/'||from_id||'/'||to_id,'fromId',from_id,'toId',to_id,'units',u,'kind',kind));
   else flows:=jsonb_set(flows,array[idx::text,'units'],to_jsonb((flows->idx->>'units')::bigint+u)); end if;
   remaining:=remaining||jsonb_build_object(from_id,(remaining->>from_id)::bigint+u,to_id,(remaining->>to_id)::bigint-u);
  end loop;
  select array_agg(key order by -(value::bigint) desc,i),array_agg(-(value::bigint) order by -(value::bigint) desc,i) into debtors,d_units
   from jsonb_each_text(remaining) r join jsonb_array_elements_text(seniority) with ordinality s(member,i) on s.member=r.key where value::bigint<0;
  select array_agg(key order by value::bigint desc,i),array_agg(value::bigint order by value::bigint desc,i) into creditors,c_units
   from jsonb_each_text(remaining) r join jsonb_array_elements_text(seniority) with ordinality s(member,i) on s.member=r.key where value::bigint>0;
  d:=1; c:=1;
  while d<=coalesce(cardinality(debtors),0) and c<=coalesce(cardinality(creditors),0) loop
   from_id:=debtors[d]; to_id:=creditors[c]; u:=least(d_units[d],c_units[c]);
   select i::integer-1 into idx from jsonb_array_elements(flows) with ordinality a(v,i) where v->>'fromId'=from_id and v->>'toId'=to_id;
   if idx is null then flows:=flows||jsonb_build_array(jsonb_build_object('id',kind||'/'||from_id||'/'||to_id,'fromId',from_id,'toId',to_id,'units',u,'kind',kind));
   else flows:=jsonb_set(flows,array[idx::text,'units'],to_jsonb((flows->idx->>'units')::bigint+u)); end if;
   d_units[d]:=d_units[d]-u; c_units[c]:=c_units[c]-u;
   if d_units[d]=0 then d:=d+1; end if;
   if c_units[c]=0 then c:=c+1; end if;
  end loop;
  result:=result||flows;
 end loop;
 return result;
end $$;

CREATE FUNCTION duty_private.compensation_consume(s jsonb, ref jsonb, amount bigint, settlement text DEFAULT NULL, contribution text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare part jsonb; edge jsonb; claims jsonb; off bigint; tail bigint; p jsonb; remaining bigint; entry jsonb;
begin
 part:=duty_private.compensation_slice(ref,amount); edge:=duty_private.compensation_locate(s,part);
 if edge is null then raise exception 'claim-no-longer-outstanding'; end if;
 off:=(part->'path'->0->>'offset')::bigint-(edge->'path'->0->>'offset')::bigint;
 select coalesce(jsonb_agg(c),'[]') into claims from jsonb_array_elements(s->'claims') c where c<>edge;
 if off>0 then claims:=claims||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(edge,off),edge->'priority',(edge->>'frozen')::boolean)); end if;
 tail:=(edge->>'units')::bigint-off-amount;
 if tail>0 then claims:=claims||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(edge,tail,off+amount),edge->'priority',(edge->>'frozen')::boolean)); end if;
 s:=jsonb_set(s,'{claims}',claims);
 for p in select value from jsonb_array_elements(part->'path') loop
  remaining:=(s->'lots'->(p->>'lotId')->>'remaining')::bigint;
  if remaining is null or remaining<amount then raise exception 'source-over-settlement'; end if;
  s:=jsonb_set(s,array['lots',p->>'lotId','remaining'],to_jsonb(remaining-amount));
 end loop;
 if settlement is not null then
  if s->'settlements' ? settlement then raise exception 'duplicate-settlement'; end if;
  entry:=jsonb_build_object('id',settlement,'claim',part,'units',amount,'reversed',false);
  if contribution is not null then entry:=entry||jsonb_build_object('contributionId',contribution); end if;
  s:=jsonb_set(s,array['settlements',settlement],entry);
 end if;
 return s;
end $$;

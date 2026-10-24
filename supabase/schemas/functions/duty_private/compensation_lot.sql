CREATE FUNCTION duty_private.compensation_lot(s jsonb, e jsonb, id text, debtor text, creditor text, amount bigint, priority jsonb DEFAULT NULL, correction text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare ref jsonb; lot jsonb;
begin
 perform duty_private.compensation_units(to_jsonb(amount),true);
 if debtor is null or creditor is null or not (s->'members' ? debtor) or not (s->'members' ? creditor) or debtor=creditor then raise exception 'invalid-endpoints'; end if;
 if s->'lots' ? id then raise exception 'duplicate-lot'; end if;
 priority:=coalesce(priority,jsonb_build_object('at',e->'at','sequence',e->'sequence','lotId',id));
 lot:=jsonb_build_object('id',id,'debtorId',debtor,'creditorId',creditor,'units',amount,'remaining',amount,'correctedUnits',amount,'priority',priority,'sourceKey',e->'sourceKey');
 if correction is not null then lot:=lot||jsonb_build_object('correctionOf',correction); end if;
 ref:=jsonb_build_object('debtorId',debtor,'creditorId',creditor,'path',jsonb_build_array(jsonb_build_object('lotId',id,'offset',0,'units',amount)));
 return jsonb_set(jsonb_set(s,array['lots',id],lot),'{claims}',(s->'claims')||jsonb_build_array(duty_private.compensation_segment(ref,priority)));
end $$;

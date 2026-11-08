CREATE FUNCTION duty_private.allocation_take(atoms jsonb, engineer text, amount bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare day text; a jsonb; n bigint; capacity jsonb:='[]';
begin
 for day,a in select * from jsonb_each(atoms) where value->>'primaryId'=engineer order by key loop
  n:=least(amount,(a->>'units')::bigint-coalesce((a->>'offset')::bigint,0)); if n=0 then continue; end if;
  capacity:=capacity||jsonb_build_array(jsonb_build_object('date',day,'offset',coalesce((a->>'offset')::bigint,0),'units',n));
  atoms:=jsonb_set(atoms,array[day,'offset'],to_jsonb(coalesce((a->>'offset')::bigint,0)+n)); amount:=amount-n;
 end loop;
 if amount<>0 then raise exception 'unbindable-duty-capacity'; end if;
 return jsonb_build_object('atoms',atoms,'capacity',capacity);
end $$;

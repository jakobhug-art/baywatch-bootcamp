create or replace function bootcamp_private.draw_wheel_ticket()
returns smallint[] language plpgsql volatile set search_path='' as $$
declare
 v_roll integer:=floor(random()*200);
 v_prize smallint:=case when v_roll<126 then 0 when v_roll<170 then 1 when v_roll<190 then 2 when v_roll<199 then 3 else 15 end;
 v_symbols smallint[]:=array[1,2,3,15];
 v_first smallint;
 v_second smallint;
begin
 if v_prize>0 then return array[v_prize,v_prize,v_prize]; end if;
 v_first:=v_symbols[1+floor(random()*cardinality(v_symbols))::integer];
 v_second:=v_symbols[1+floor(random()*cardinality(v_symbols))::integer];
 if v_first=v_second then v_symbols:=array_remove(v_symbols,v_first); end if;
 return array[v_first,v_second,v_symbols[1+floor(random()*cardinality(v_symbols))::integer]];
end;
$$;

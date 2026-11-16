create or replace function public.bootcamp_spin_with_ticket(
 p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_values smallint[]
)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_coins integer:=case p_slot when 10 then 15 when 11 then 7 when 12 then 3 else 0 end;
begin
 if p_slot=13 then
  perform pg_advisory_xact_lock(72417001);
  v_coins:=-least(2,greatest(0,bootcamp_private.balance(p_user)));
  p_card:=jsonb_set(p_card,'{description}',to_jsonb(case v_coins
   when 0 then 'Dein Münzkonto war leer.'
   when -1 then 'Dir wurde 1 Münze abgezogen.'
   else 'Dir wurden 2 Münzen abgezogen.' end));
 end if;
 perform public.bootcamp_spin(p_user,p_day,p_turn,p_slot,p_card,0);
 update bootcamp_private.wheel_spins set scratch_values=p_values where user_id=p_user and day=p_day and turn=p_turn;
 if v_coins<>0 then
  insert into bootcamp_private.coin_entries(user_id,amount,label,day)
  values(p_user,v_coins,case p_slot when 10 then 'Glücksrad-Jackpot' when 13 then 'Glücksrad · Münzverlust' else 'Glücksrad' end,p_day);
 end if;
end;
$$;

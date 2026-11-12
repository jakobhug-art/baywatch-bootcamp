alter table bootcamp_private.wheel_spins
 add column scratch_values smallint[] check (
  cardinality(scratch_values)=3 and array_position(scratch_values,null) is null
  and scratch_values <@ array[1,2,3,15]::smallint[]
 ),
 add column scratch_claimed_on date;

create function public.bootcamp_spin_with_ticket(
 p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_values smallint[]
)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.bootcamp_spin(p_user,p_day,p_turn,p_slot,p_card,0);
 update bootcamp_private.wheel_spins set scratch_values=p_values
 where user_id=p_user and day=p_day and turn=p_turn;
 if p_slot=10 then
  insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,15,'Glücksrad-Jackpot',p_day);
 end if;
end;
$$;

create function public.bootcamp_claim_scratch(p_user uuid,p_day date,p_turn integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_values smallint[];
 v_claimed_on date;
 v_prize integer := 0;
begin
 select scratch_values,scratch_claimed_on into v_values,v_claimed_on
 from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=p_turn for update;
 if v_values is null then raise sqlstate 'PT404' using message='Rubbellos nicht gefunden.'; end if;
 if v_values[1]=v_values[2] and v_values[2]=v_values[3] then v_prize:=v_values[1]; end if;
 if v_claimed_on is null then
  update bootcamp_private.wheel_spins set scratch_claimed_on=bootcamp_private.today()
  where user_id=p_user and day=p_day and turn=p_turn;
  if v_prize>0 then
   insert into bootcamp_private.coin_entries(user_id,amount,label,day)
   values(p_user,v_prize,'Rubbellos',bootcamp_private.today());
  end if;
 end if;
 return jsonb_build_object('prize',v_prize);
end;
$$;

create or replace function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb;
 v_day date;
 v_bonus integer;
begin
 if public.bootcamp_has_profile(p_user) then
  perform bootcamp_private.settle_season_coins(bootcamp_private.today());
 end if;
 v_state:=bootcamp_private.bootcamp_training_state(p_user);
 v_day:=(v_state->'deck'->>'day')::date;
 v_state:=jsonb_set(v_state,'{deck,weeklyPoints}',(
  select jsonb_object_agg(difficulty,bootcamp_private.weekly_points(difficulty))
  from unnest(array['Leicht','Mittel','Schwer']) as levels(difficulty)
 ));
 select photo_bonus into v_bonus from bootcamp_private.workout_finishes where user_id=p_user and day=v_day;
 return v_state || jsonb_build_object(
  'workoutFinished',v_bonus is not null,
  'photoBonus',coalesce(v_bonus,0),
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day'-'scratch_values'-'scratch_claimed_on' order by s.turn
   ) from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'scratchTickets',coalesce((select jsonb_agg(jsonb_build_object(
   'day',day,'turn',turn,'values',scratch_values,'claimed',scratch_claimed_on is not null
  ) order by day desc,turn desc) from bootcamp_private.wheel_spins
  where user_id=p_user and scratch_values is not null and (day=v_day or scratch_claimed_on is null or scratch_claimed_on=v_day)),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
 );
end;
$$;

revoke all on function public.bootcamp_spin_with_ticket(uuid,date,integer,integer,jsonb,smallint[]),
 public.bootcamp_claim_scratch(uuid,date,integer) from public,anon,authenticated;
grant execute on function public.bootcamp_spin_with_ticket(uuid,date,integer,integer,jsonb,smallint[]),
 public.bootcamp_claim_scratch(uuid,date,integer) to service_role;

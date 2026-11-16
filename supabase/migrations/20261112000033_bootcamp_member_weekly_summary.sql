create or replace function public.bootcamp_member_summary(p_user uuid,p_member uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_handle text;
 v_deck jsonb;
 v_day date;
 v_daily jsonb;
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 select handle into v_handle from bootcamp_private.profiles where id=p_member;
 if not found then raise sqlstate 'PT404' using message='Mitglied nicht gefunden.'; end if;
 v_deck:=bootcamp_private.current_deck();
 v_day:=(v_deck->>'day')::date;
 v_daily:=bootcamp_private.scored_daily(p_member,v_day,v_deck->'daily');
 return jsonb_build_object(
  'handle',v_handle,'balance',bootcamp_private.balance(p_member),
  'rest',exists(select 1 from bootcamp_private.rest_days where user_id=p_member and day=v_day),
  'workoutFinished',exists(select 1 from bootcamp_private.workout_finishes where user_id=p_member and day=v_day),
  'daily',(select coalesce(jsonb_agg(jsonb_build_object(
    'name',card->>'name','unit',card->>'unit','target',card->'target','amount',coalesce(q.amount,0),
    'skipped',not(v_daily @> jsonb_build_array(card))
   ) order by position),'[]'::jsonb)
   from jsonb_array_elements(v_deck->'daily') with ordinality as cards(card,position)
   left join bootcamp_private.effective_quantities q on q.user_id=p_member and q.day=v_day and q.exercise=card->>'id'),
  'weekly',(select coalesce(jsonb_agg(card->>2 order by position),'[]'::jsonb)
   from jsonb_array_elements(v_deck->'weekly') with ordinality as cards(card,position)
   join bootcamp_private.marks m on m.user_id=p_member and m.week=(v_deck->>'week')::date
     and m.exercise=card->>0)
 );
end;
$$;

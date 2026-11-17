create table bootcamp_private.training_replacements (
 user_id uuid not null,
 day date not null,
 exercise text not null,
 primary key(user_id,day),
 foreign key(user_id,day) references bootcamp_private.daily_skips on delete cascade
);
alter table bootcamp_private.training_replacements enable row level security;

create function public.bootcamp_replace_with_training(p_user uuid,p_day date,p_exercise text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_skip text;
 v_replaced text;
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 select exercise into v_replaced from bootcamp_private.training_replacements where user_id=p_user and day=p_day;
 if found then
  if v_replaced=p_exercise then return; end if;
  raise sqlstate 'PT409' using message='Du hast heute bereits eine Übung durch Training ersetzt.';
 end if;
 perform bootcamp_private.require_open_workout(p_user,p_day);
 select exercise into v_skip from bootcamp_private.daily_skips where user_id=p_user and day=p_day;
 if not found then raise sqlstate 'PT409' using message='Streiche zuerst eine Übung für heute.'; end if;
 if exists(select 1 from bootcamp_private.rest_days where user_id=p_user and day=p_day) then
  raise sqlstate 'PT409' using message='Für heute ist bereits ein freier Tag aktiv.';
 end if;
 if p_exercise=v_skip or not exists(
  select 1 from jsonb_array_elements(bootcamp_private.current_deck()->'daily') card where card->>'id'=p_exercise
 ) then raise sqlstate 'PT400' using message='Wähle eine verbleibende Tagesübung.'; end if;
 insert into bootcamp_private.training_replacements values(p_user,p_day,p_exercise);
end;
$$;

revoke all on function public.bootcamp_replace_with_training(uuid,date,text) from public,anon,authenticated;
grant execute on function public.bootcamp_replace_with_training(uuid,date,text) to service_role;

create or replace view bootcamp_private.effective_quantities as
select q.* from bootcamp_private.quantities q
left join bootcamp_private.challenge_periods p on p.period=q.day and p.kind='daily'
where not exists (select 1 from bootcamp_private.rest_days r where r.user_id=q.user_id and r.day=q.day)
 and not exists (select 1 from bootcamp_private.training_replacements t
  where t.user_id=q.user_id and t.day=q.day and t.exercise=q.exercise)
 and (p.data is null or bootcamp_private.scored_daily(q.user_id,q.day,p.data) @> jsonb_build_array(jsonb_build_object('id',q.exercise)))
union all
select r.user_id,r.day,card->>'id',
 greatest((card->>'target')::integer,coalesce(q.amount,0)),
 greatest(bootcamp_private.exercise_points(card,(card->>'target')::integer),coalesce(q.points,0)),true
from bootcamp_private.rest_days r
join bootcamp_private.challenge_periods p on p.period=r.day and p.kind='daily'
cross join lateral jsonb_array_elements(bootcamp_private.scored_daily(r.user_id,r.day,p.data)) card
left join bootcamp_private.quantities q on q.user_id=r.user_id and q.day=r.day and q.exercise=card->>'id'
where not exists (select 1 from bootcamp_private.training_replacements t
 where t.user_id=r.user_id and t.day=r.day and t.exercise=card->>'id')
union all
select t.user_id,t.day,t.exercise,(card->>'target')::integer,
 bootcamp_private.exercise_points(card,(card->>'target')::integer),true
from bootcamp_private.training_replacements t
join bootcamp_private.challenge_periods p on p.period=t.day and p.kind='daily'
cross join lateral jsonb_array_elements(p.data) card
where card->>'id'=t.exercise;

create or replace function public.bootcamp_save_quantity(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_deck jsonb := bootcamp_private.current_deck();
 v_card jsonb;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.require_open_workout(p_user,p_day);
 if exists(select 1 from bootcamp_private.training_replacements where user_id=p_user and day=p_day and exercise=p_exercise) then
  raise sqlstate 'PT409' using message='Diese Übung wurde heute durch Training ersetzt.';
 end if;
 select card into v_card from jsonb_array_elements(v_deck->'daily') card where card->>'id'=p_exercise;
 if v_card is null or p_amount is null or p_amount not between 0 and 10000 then
  raise sqlstate 'PT400' using message='Wähle eine Tagesübung und gib eine ganze Zahl zwischen 0 und 10.000 ein.';
 end if;
 insert into bootcamp_private.quantities(user_id,day,exercise,amount,points,reached)
 values(p_user,p_day,p_exercise,p_amount,bootcamp_private.exercise_points(v_card,p_amount),p_amount>=(v_card->>'target')::integer)
 on conflict(user_id,day,exercise) do update set amount=excluded.amount,points=excluded.points,reached=excluded.reached;
end;
$$;

create or replace function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb;
 v_day date;
 v_bonus integer;
 v_default text;
 v_skip text;
 v_training text;
begin
 if public.bootcamp_has_profile(p_user) then
  perform bootcamp_private.settle_season_coins(bootcamp_private.today());
 end if;
 v_state:=bootcamp_private.bootcamp_training_state(p_user);
 v_day:=(v_state->'deck'->>'day')::date;
 v_default:=bootcamp_private.skip_default(v_day,v_state->'deck'->'daily');
 select exercise into v_skip from bootcamp_private.daily_skips where user_id=p_user and day=v_day;
 select exercise into v_training from bootcamp_private.training_replacements where user_id=p_user and day=v_day;
 v_state:=jsonb_set(v_state,'{deck,weeklyPoints}',(
  select jsonb_object_agg(difficulty,bootcamp_private.weekly_points(difficulty))
  from unnest(array['Leicht','Mittel','Schwer']) as levels(difficulty)
 ));
 select photo_bonus into v_bonus from bootcamp_private.workout_finishes where user_id=p_user and day=v_day;
 return v_state || jsonb_build_object(
  'workoutFinished',v_bonus is not null,'photoBonus',coalesce(v_bonus,0),
  'defaultSkip',v_default,'skippedExercise',case when v_bonus is not null then coalesce(v_skip,v_default) else v_skip end,
  'trainingExercise',v_training,
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day'-'scratch_values'-'scratch_claimed_on' order by s.turn
   ) from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'scratchTickets',coalesce((select jsonb_agg(jsonb_build_object(
   'day',day,'turn',turn,'values',scratch_values,'claimed',scratch_claimed_on is not null
  ) order by turn desc) from bootcamp_private.wheel_spins
  where user_id=p_user and day=v_day and scratch_values is not null),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
 );
end;
$$;

create or replace function public.bootcamp_member_summary(p_user uuid,p_member uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_handle text;
 v_deck jsonb;
 v_day date;
 v_daily jsonb;
 v_training text;
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 select handle into v_handle from bootcamp_private.profiles where id=p_member;
 if not found then raise sqlstate 'PT404' using message='Mitglied nicht gefunden.'; end if;
 v_deck:=bootcamp_private.current_deck();
 v_day:=(v_deck->>'day')::date;
 v_daily:=bootcamp_private.scored_daily(p_member,v_day,v_deck->'daily');
 select exercise into v_training from bootcamp_private.training_replacements where user_id=p_member and day=v_day;
 return jsonb_build_object(
  'handle',v_handle,'balance',bootcamp_private.balance(p_member),
  'rest',exists(select 1 from bootcamp_private.rest_days where user_id=p_member and day=v_day),
  'workoutFinished',exists(select 1 from bootcamp_private.workout_finishes where user_id=p_member and day=v_day),
  'daily',(select coalesce(jsonb_agg(jsonb_build_object(
    'name',card->>'name','unit',card->>'unit','target',card->'target','amount',coalesce(q.amount,0),
    'skipped',not(v_daily @> jsonb_build_array(card)),
    'trainingReplaced',coalesce(card->>'id'=v_training,false)
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

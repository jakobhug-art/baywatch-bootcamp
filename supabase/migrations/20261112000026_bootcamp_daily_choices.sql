create table bootcamp_private.daily_skips (
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 day date not null,
 exercise text not null,
 primary key(user_id,day)
);
alter table bootcamp_private.daily_skips enable row level security;

create table bootcamp_private.daily_choice_policy (starts_on date primary key);
alter table bootcamp_private.daily_choice_policy enable row level security;
insert into bootcamp_private.daily_choice_policy values(bootcamp_private.today());

insert into bootcamp_private.challenge_catalog(id,kind,data) values ('jogging','daily',
 '{"id":"jogging","name":"Joggen","target":5000,"step":1000,"unit":"m","goalPoints":60,"color":"pink","icon":"jogging","hint":""}')
on conflict(id) do nothing;

update bootcamp_private.challenge_periods p set data=p.data||jsonb_build_array(c.data)
from bootcamp_private.challenge_catalog c
where c.id='jogging' and p.kind='daily' and p.period=bootcamp_private.today()
 and not exists(select 1 from jsonb_array_elements(p.data) card where card->>'id'='jogging');

create function bootcamp_private.skip_default(p_day date,p_cards jsonb)
returns text language sql stable set search_path='' as $$
 select card->>'id' from jsonb_array_elements(p_cards) with ordinality as cards(card,position)
 where jsonb_array_length(p_cards)>1 and p_day>=(select min(starts_on) from bootcamp_private.daily_choice_policy)
 order by (card->>'id'='jogging') desc,position desc limit 1
$$;

create function bootcamp_private.scored_daily(p_user uuid,p_day date,p_cards jsonb)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_path_query_array(p_cards,'$[*] ? (@.id != $skip)',jsonb_build_object('skip',choice.exercise))
 from (select coalesce((select exercise from bootcamp_private.daily_skips where user_id=p_user and day=p_day),
  bootcamp_private.skip_default(p_day,p_cards),'') as exercise) choice
$$;

create function public.bootcamp_choose_skip(p_user uuid,p_day date,p_exercise text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_cards jsonb;
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.require_open_workout(p_user,p_day);
 v_cards:=bootcamp_private.current_deck()->'daily';
 if bootcamp_private.skip_default(p_day,v_cards) is null or not exists(
  select 1 from jsonb_array_elements(v_cards) card where card->>'id'=p_exercise
 ) then raise sqlstate 'PT400' using message='Wähle eine Tagesübung zum Streichen.'; end if;
 insert into bootcamp_private.daily_skips values(p_user,p_day,p_exercise)
 on conflict(user_id,day) do update set exercise=excluded.exercise;
end;
$$;

create or replace function public.bootcamp_finish_workout(p_user uuid,p_day date)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 if bootcamp_private.skip_default(p_day,bootcamp_private.current_deck()->'daily') is not null
  and not exists(select 1 from bootcamp_private.daily_skips where user_id=p_user and day=p_day)
  and not exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  raise sqlstate 'PT409' using message='Streiche zuerst eine Übung für heute.';
 end if;
 insert into bootcamp_private.workout_finishes(user_id,day) values(p_user,p_day) on conflict do nothing;
end;
$$;

create or replace view bootcamp_private.effective_quantities as
select q.* from bootcamp_private.quantities q
left join bootcamp_private.challenge_periods p on p.period=q.day and p.kind='daily'
where not exists (select 1 from bootcamp_private.rest_days r where r.user_id=q.user_id and r.day=q.day)
 and (p.data is null or bootcamp_private.scored_daily(q.user_id,q.day,p.data) @> jsonb_build_array(jsonb_build_object('id',q.exercise)))
union all
select r.user_id,r.day,card->>'id',
 greatest((card->>'target')::integer,coalesce(q.amount,0)),
 greatest(bootcamp_private.exercise_points(card,(card->>'target')::integer),coalesce(q.points,0)),true
from bootcamp_private.rest_days r
join bootcamp_private.challenge_periods p on p.period=r.day and p.kind='daily'
cross join lateral jsonb_array_elements(bootcamp_private.scored_daily(r.user_id,r.day,p.data)) card
left join bootcamp_private.quantities q on q.user_id=r.user_id and q.day=r.day and q.exercise=card->>'id';

create or replace view bootcamp_private.completed_days as
select q.user_id,q.day
from bootcamp_private.effective_quantities q
join bootcamp_private.challenge_periods p on p.period=q.day and p.kind='daily'
where q.reached
group by q.user_id,q.day,p.data
having count(*)=jsonb_array_length(bootcamp_private.scored_daily(q.user_id,q.day,p.data));

create or replace function public.bootcamp_claim_scratch(p_user uuid,p_day date,p_turn integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_values smallint[];
 v_claimed_on date;
 v_prize integer := 0;
begin
 perform bootcamp_private.check_day(p_day);
 select scratch_values,scratch_claimed_on into v_values,v_claimed_on
 from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=p_turn for update;
 if v_values is null then raise sqlstate 'PT404' using message='Rubbellos nicht gefunden.'; end if;
 if v_values[1]=v_values[2] and v_values[2]=v_values[3] then v_prize:=v_values[1]; end if;
 if v_claimed_on is null then
  update bootcamp_private.wheel_spins set scratch_claimed_on=p_day where user_id=p_user and day=p_day and turn=p_turn;
  if v_prize>0 then
   insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,v_prize,'Rubbellos',p_day);
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
 v_default text;
 v_skip text;
begin
 if public.bootcamp_has_profile(p_user) then
  perform bootcamp_private.settle_season_coins(bootcamp_private.today());
 end if;
 v_state:=bootcamp_private.bootcamp_training_state(p_user);
 v_day:=(v_state->'deck'->>'day')::date;
 v_default:=bootcamp_private.skip_default(v_day,v_state->'deck'->'daily');
 select exercise into v_skip from bootcamp_private.daily_skips where user_id=p_user and day=v_day;
 v_state:=jsonb_set(v_state,'{deck,weeklyPoints}',(
  select jsonb_object_agg(difficulty,bootcamp_private.weekly_points(difficulty))
  from unnest(array['Leicht','Mittel','Schwer']) as levels(difficulty)
 ));
 select photo_bonus into v_bonus from bootcamp_private.workout_finishes where user_id=p_user and day=v_day;
 return v_state || jsonb_build_object(
  'workoutFinished',v_bonus is not null,'photoBonus',coalesce(v_bonus,0),
  'defaultSkip',v_default,'skippedExercise',case when v_bonus is not null then coalesce(v_skip,v_default) else v_skip end,
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

revoke all on function public.bootcamp_choose_skip(uuid,date,text) from public,anon,authenticated;
grant execute on function public.bootcamp_choose_skip(uuid,date,text) to service_role;

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
     and m.exercise=card->>0 and m.earned_on=v_day)
 );
end;
$$;

create or replace function public.bootcamp_save_challenge(p_user uuid,p_input jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_id text := nullif(p_input->>'id','');
 v_kind text := p_input->>'kind';
 v_name text := trim(coalesce(p_input->>'name',''));
 v_hint text := trim(coalesce(p_input->>'hint',''));
 v_enabled boolean;
 v_old bootcamp_private.challenge_catalog%rowtype;
 v_data jsonb;
 v_target integer;
 v_goal_points integer;
 v_step integer;
 v_points integer;
 v_unit text := p_input->>'unit';
 v_category text := p_input->>'category';
 v_difficulty text := p_input->>'difficulty';
 v_group text;
 v_groups text[] := array['Bewegung','Ernährung','Spaß & Abwechslung'];
begin
 perform bootcamp_private.require_admin(p_user);
 if v_kind is null or v_kind not in ('daily','weekly') or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
    or char_length(v_name) not between 1 and 80 or char_length(v_hint)>300 then
  raise sqlstate 'PT400' using message='Prüfe Titel und Beschreibung.';
 end if;
 perform pg_advisory_xact_lock(72417002);
 perform bootcamp_private.current_deck();
 v_enabled := (p_input->>'enabled')::boolean;
 if v_id is not null then
  select * into v_old from bootcamp_private.challenge_catalog where id=v_id and kind=v_kind;
  if not found then raise sqlstate 'PT404' using message='Aufgabe nicht gefunden.'; end if;
 else
  v_id := gen_random_uuid()::text;
 end if;
 v_data := jsonb_build_object('id',v_id,'name',v_name,'hint',v_hint);
 if v_kind='daily' then
  if coalesce(p_input->>'target','') !~ '^[0-9]{1,5}$' or coalesce(p_input->>'step','') !~ '^[0-9]{1,5}$' then
   raise sqlstate 'PT400' using message='Prüfe Zielmenge und Schrittweite.';
  end if;
  if coalesce(p_input->>'goalPoints','60') !~ '^[0-9]{1,2}$' then
   raise sqlstate 'PT400' using message='Zielpunkte müssen zwischen 1 und 75 liegen.';
  end if;
  v_goal_points := coalesce((p_input->>'goalPoints')::integer,60);
  if v_goal_points not between 1 and 75 then
   raise sqlstate 'PT400' using message='Zielpunkte müssen zwischen 1 und 75 liegen.';
  end if;
  v_target := (p_input->>'target')::integer;
  v_step := (p_input->>'step')::integer;
  if v_target not between 1 and 10000 or v_step not between 1 and v_target or v_unit is null or v_unit not in ('Wdh.','Sek.','m') then
   raise sqlstate 'PT400' using message='Prüfe Zielmenge, Einheit und Schrittweite.';
  end if;
  if not v_enabled and not exists(select 1 from bootcamp_private.challenge_catalog where kind='daily' and enabled and id<>v_id) then
   raise sqlstate 'PT400' using message='Mindestens eine Tagesübung muss aktiv bleiben.';
  end if;
  v_data := v_data||jsonb_build_object('target',v_target,'step',v_step,'unit',v_unit,'goalPoints',v_goal_points,
   'icon',coalesce(v_old.data->>'icon','squat'),'color',coalesce(v_old.data->>'color','lime'));
 else
  v_points:=bootcamp_private.weekly_points(v_difficulty);
  if v_points is null or v_hint='' or v_category is null or not (v_category=any(v_groups)) then
   raise sqlstate 'PT400' using message='Prüfe Kategorie, Schwierigkeit und Beschreibung.';
  end if;
  foreach v_group in array v_groups loop
   if not (v_enabled and v_category=v_group) and not exists(
    select 1 from bootcamp_private.challenge_catalog where kind='weekly' and enabled and id<>v_id and data->>'category'=v_group
   ) then raise sqlstate 'PT400' using message='In jeder Wochenkategorie muss eine Aufgabe aktiv bleiben.'; end if;
  end loop;
  v_data := v_data||jsonb_build_object('points',v_points,'category',v_category,'difficulty',v_difficulty,
   'icon',case v_category when 'Bewegung' then '↗' when 'Ernährung' then '✿' else '✦' end,
   'color',case v_category when 'Bewegung' then 'pink' when 'Ernährung' then 'lime' else 'cyan' end);
 end if;
 insert into bootcamp_private.challenge_catalog(id,kind,enabled,data) values(v_id,v_kind,v_enabled,v_data)
 on conflict(id) do update set enabled=excluded.enabled,data=excluded.data;
end;
$$;

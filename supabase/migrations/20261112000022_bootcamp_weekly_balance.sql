create or replace function bootcamp_private.weekly_points(p_difficulty text)
returns integer language sql immutable set search_path='' as $$
 select case p_difficulty when 'Leicht' then 55 when 'Mittel' then 70 when 'Schwer' then 90 end
$$;

-- Reclassify standard cards without replacing their instructions or touching weekly draws.
update bootcamp_private.challenge_catalog c
set data=c.data||jsonb_build_object('difficulty',tiers.difficulty)
from (values
 ('stairs','Schwer'),('walk','Mittel'),('cycle','Mittel'),
 ('dance','Mittel'),('balance','Mittel'),('mobility','Mittel'),('friend','Mittel'),
 ('pool-0-1','Mittel'),('pool-0-5','Mittel'),('pool-0-11','Mittel'),
 ('pool-2-0','Leicht'),('pool-2-2','Leicht'),('pool-2-3','Mittel'),
 ('pool-2-7','Leicht'),('pool-2-8','Mittel'),('pool-2-10','Mittel'),
 ('pool-2-11','Mittel'),('pool-2-12','Mittel')
) tiers(id,difficulty)
where c.kind='weekly' and c.id=tiers.id;

update bootcamp_private.challenge_catalog
set data=data||'{"name":"Wandsitz · 240 Sekunden","hint":"Sammle insgesamt 240 Sekunden Wandsitz in mehreren Sätzen, etwa 4 × 60 Sekunden. Verteile die Sätze bei Bedarf auf mehrere Tage.","difficulty":"Schwer"}'::jsonb
where kind='weekly' and id='pool-0-6';

insert into bootcamp_private.challenge_catalog(id,kind,data) values
 ('wall-sit-90','weekly','{"id":"wall-sit-90","name":"Wandsitz · 90 Sekunden","hint":"Sammle insgesamt 90 Sekunden Wandsitz, etwa 3 × 30 Sekunden.","difficulty":"Leicht","category":"Bewegung","icon":"↗","color":"pink"}'),
 ('wall-sit-150','weekly','{"id":"wall-sit-150","name":"Wandsitz · 150 Sekunden","hint":"Sammle insgesamt 150 Sekunden Wandsitz, etwa 3 × 50 Sekunden. Mach zwischen den Sätzen Pause.","difficulty":"Mittel","category":"Bewegung","icon":"↗","color":"pink"}')
on conflict(id) do nothing;

-- The existing trigger applies the policy to the remaining catalog entries, including custom cards.
update bootcamp_private.challenge_catalog
set data=data
where kind='weekly' and bootcamp_private.weekly_points(data->>'difficulty') is not null
 and (data->>'points')::integer is distinct from bootcamp_private.weekly_points(data->>'difficulty');

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
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day' order by s.turn
   ) from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
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
  if v_target not between 1 and 10000 or v_step not between 1 and v_target or v_unit is null or v_unit not in ('Wdh.','Sek.') then
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

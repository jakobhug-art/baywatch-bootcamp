create table bootcamp_private.workout_finishes(
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 day date not null,
 primary key(user_id,day)
);
alter table bootcamp_private.workout_finishes enable row level security;

create function bootcamp_private.require_open_workout(p_user uuid,p_day date)
returns void language plpgsql stable set search_path='' as $$
begin
 if exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  raise sqlstate 'PT409' using message='Das Workout ist bereits abgeschlossen.';
 end if;
end;
$$;

create function public.bootcamp_finish_workout(p_user uuid,p_day date)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.current_deck();
 insert into bootcamp_private.workout_finishes values(p_user,p_day) on conflict do nothing;
end;
$$;
revoke all on function public.bootcamp_finish_workout(uuid,date) from public,anon,authenticated;
grant execute on function public.bootcamp_finish_workout(uuid,date) to service_role;

create or replace view bootcamp_private.point_events as
select user_id,day,'exercise:'||exercise as event,points from bootcamp_private.effective_quantities
union all select user_id,earned_on,'weekly:'||exercise,points from bootcamp_private.marks
union all select user_id,day,'wheel:'||turn,case when completed then reward else initial end from bootcamp_private.wheel_spins
union all
select user_id,day,'monthly',100 from (
 select user_id,day,row_number() over(partition by user_id,date_trunc('month',day) order by day) as position
 from bootcamp_private.completed_days
) days where position=12
union all
select p.id, dates.day::date, 'daily_penalty',
 -policy.points_per_missing*(jsonb_array_length(snapshot.data)-coalesce(achieved.count,0)::integer)
from bootcamp_private.profiles p
join auth.users account on account.id=p.id
cross join bootcamp_private.daily_penalty_policy policy
cross join lateral generate_series(greatest(policy.starts_on,(account.created_at at time zone 'Europe/Berlin')::date),
 bootcamp_private.today(), interval '1 day') dates(day)
cross join lateral (
 select data from bootcamp_private.challenge_periods where kind='daily' and period<=dates.day::date
 order by period desc limit 1
) snapshot
cross join lateral (
 select count(*) from bootcamp_private.effective_quantities q where q.user_id=p.id and q.day=dates.day::date and q.reached
) achieved
where achieved.count<jsonb_array_length(snapshot.data)
 and (dates.day::date<bootcamp_private.today()
   or exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=p.id and f.day=dates.day::date));

create or replace function public.bootcamp_save_quantity(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_deck jsonb := bootcamp_private.current_deck();
 v_card jsonb;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.require_open_workout(p_user,p_day);
 select card into v_card from jsonb_array_elements(v_deck->'daily') card where card->>'id'=p_exercise;
 if v_card is null or p_amount is null or p_amount not between 0 and 10000 then
  raise sqlstate 'PT400' using message='Wähle eine Tagesübung und gib eine ganze Zahl zwischen 0 und 10.000 ein.';
 end if;
 insert into bootcamp_private.quantities(user_id,day,exercise,amount,points,reached)
 values(p_user,p_day,p_exercise,p_amount,bootcamp_private.exercise_points(v_card,p_amount),p_amount>=(v_card->>'target')::integer)
 on conflict(user_id,day,exercise) do update set amount=excluded.amount,points=excluded.points,reached=excluded.reached;
end;
$$;

create or replace function public.bootcamp_spin(p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_coins integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_first_bonus boolean;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.current_deck();
 select bonus into v_first_bonus from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=1;
 if v_first_bonus is null and not exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  raise sqlstate 'PT403' using message='Schließe zuerst dein Workout ab.';
 end if;
 if p_turn is null or p_turn not in (1,2)
    or (p_turn=1 and v_first_bonus is not null)
    or (p_turn=2 and v_first_bonus is distinct from true)
    or exists(select 1 from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=p_turn) then
  raise sqlstate 'PT409' using message='Heute ist kein weiterer Dreh verfügbar.';
 end if;
 insert into bootcamp_private.wheel_spins(user_id,day,turn,slot,title,description,initial,reward,bonus)
 values(p_user,p_day,p_turn,p_slot,p_card->>'title',p_card->>'description',(p_card->>'initial')::integer,
  (p_card->>'reward')::integer,p_turn=1 and coalesce((p_card->>'bonus')::boolean,false));
 if p_coins between 1 and 3 then
  insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,p_coins,'Glücksrad',p_day);
 end if;
 if p_card->'rest'='true'::jsonb then
  insert into bootcamp_private.rest_vouchers(user_id) values(p_user);
 end if;
end;
$$;

create or replace function public.bootcamp_buy(p_user uuid,p_day date,p_request uuid,p_kind text,p_target uuid,p_detail text,p_source bigint,p_audio_path text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare
 v_price integer := case p_kind when 'voice' then 2 when 'symbol' then 5 when 'exercise' then 6 when 'return' then 4 when 'rest' then 12 end;
 v_label text := case p_kind when 'voice' then 'Sprachnachricht' when 'symbol' then 'Symbol-Prank' when 'exercise' then 'Extraübung' when 'return' then 'Retourkutsche' else 'Freier Tag' end;
 v_expires date := p_day;
 v_voucher bigint;
 v_source bootcamp_private.pranks%rowtype;
begin
 perform bootcamp_private.check_day(p_day);
 if v_price is null or p_request is null then raise sqlstate 'PT400' using message='Wähle eine Aktion.'; end if;
 perform pg_advisory_xact_lock(72417001);
 insert into bootcamp_private.coin_requests values(p_user,p_request) on conflict do nothing;
 if not found then return false; end if;
 if p_kind='rest' then
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
  perform bootcamp_private.require_open_workout(p_user,p_day);
  select id into v_voucher from bootcamp_private.rest_vouchers where user_id=p_user and used is null order by id limit 1;
 end if;
 if v_voucher is null and bootcamp_private.balance(p_user)<v_price then
  raise sqlstate 'PT409' using message='Du hast nicht genug Münzen.';
 end if;
 if p_kind='rest' then
  perform bootcamp_private.current_deck();
  insert into bootcamp_private.rest_days values(p_user,p_day) on conflict do nothing;
  if not found then raise sqlstate 'PT409' using message='Heute ist bereits ein freier Tag.'; end if;
  if v_voucher is not null then
   update bootcamp_private.rest_vouchers set used=p_day where id=v_voucher;
   return true;
  end if;
 else
  if p_kind='return' then
   select * into v_source from bootcamp_private.pranks where id=p_source and recipient=p_user and kind<>'return' and expires>=p_day;
   if not found or exists(select 1 from bootcamp_private.pranks where source=p_source) then
    raise sqlstate 'PT409' using message='Diese Retourkutsche ist nicht verfügbar.';
   end if;
   p_target := v_source.sender;
   if v_source.kind='exercise' then p_detail := v_source.detail; end if;
  else
   p_source := null;
  end if;
  if p_target is null or p_target=p_user or not exists(select 1 from bootcamp_private.profiles where id=p_target) then
   raise sqlstate 'PT400' using message='Wähle eine Person.';
  end if;
  if p_kind='symbol' then
   if p_detail is null or p_detail not in ('💩','❤️','🍑','🍆','🖕') then raise sqlstate 'PT400' using message='Wähle ein Symbol.'; end if;
   if exists(select 1 from bootcamp_private.pranks where recipient=p_target and kind='symbol' and expires>=p_day) then
    raise sqlstate 'PT409' using message='Diese Person hat bereits einen aktiven Symbol-Prank.';
   end if;
   v_expires := p_day+6;
  elsif p_kind in ('exercise','return') then
   if p_detail is null or p_detail not in ('3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze') then
    raise sqlstate 'PT400' using message='Wähle eine Extraübung.';
   end if;
   if exists(select 1 from bootcamp_private.pranks where recipient=p_target and day=p_day and kind in ('exercise','return')) then
    raise sqlstate 'PT409' using message='Diese Person hat heute bereits eine Extraübung erhalten.';
   end if;
  elsif p_kind='voice' then
   if p_audio_path is null or p_detail is null or p_detail not in ('audio/webm','audio/ogg','audio/mp4') then
    raise sqlstate 'PT400' using message='Die Aufnahme fehlt oder hat ein ungültiges Format.';
   end if;
   v_expires := p_day+6;
  end if;
  insert into bootcamp_private.pranks(sender,recipient,kind,detail,day,expires,source,audio_path)
  values(p_user,p_target,p_kind,p_detail,p_day,v_expires,p_source,p_audio_path);
 end if;
 insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,-v_price,v_label,p_day);
 return true;
end;
$$;

create or replace function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb := bootcamp_private.bootcamp_training_state(p_user);
 v_day date := (v_state->'deck'->>'day')::date;
begin
 return v_state || jsonb_build_object(
  'workoutFinished',exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=v_day),
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day' order by s.turn)
   from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
 );
end;
$$;

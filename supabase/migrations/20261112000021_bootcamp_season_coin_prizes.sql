create table bootcamp_private.season_coin_policy(
 singleton boolean primary key default true check(singleton),
 starts_on date not null,
 prizes integer[] not null
);
alter table bootcamp_private.season_coin_policy enable row level security;
insert into bootcamp_private.season_coin_policy(starts_on,prizes)
values(bootcamp_private.season_start(bootcamp_private.today()),array[30,20,10]);

create table bootcamp_private.season_coin_settlements(
 season_start date primary key,
 payouts jsonb not null
);
alter table bootcamp_private.season_coin_settlements enable row level security;

create function bootcamp_private.settle_season_coins(p_day date)
returns void language plpgsql set search_path='' as $$
declare
 v_start date;
 v_next date;
 v_prizes integer[];
 v_payouts jsonb;
begin
 select prizes into v_prizes from bootcamp_private.season_coin_policy;
 for v_start in
  select season_date::date from bootcamp_private.season_coin_policy policy
  cross join lateral generate_series(policy.starts_on,
   (bootcamp_private.season_start(p_day)-interval '2 months')::date,interval '2 months') as dates(season_date)
  where not exists(select 1 from bootcamp_private.season_coin_settlements s where s.season_start=dates.season_date::date)
  order by season_date
 loop
  v_next:=(v_start+interval '2 months')::date;
  with standings as (
   select handle,points,rank() over (order by points desc)::integer as place
   from jsonb_to_recordset(bootcamp_private.standings(v_start,v_next-1)) as standing(handle text,points bigint)
   where points>0
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'handle',s.handle,'points',s.points,'place',s.place,'coins',v_prizes[s.place])
   order by s.place,lower(s.handle)),'[]'::jsonb) into v_payouts
  from standings s join bootcamp_private.profiles p on p.handle=s.handle
  where s.place<=cardinality(v_prizes);

  insert into bootcamp_private.season_coin_settlements(season_start,payouts)
  values(v_start,v_payouts) on conflict do nothing;
  if found then
   insert into bootcamp_private.coin_entries(user_id,amount,label,day)
   select id,coins,'Season-Prämie · Platz '||place,v_next
   from jsonb_to_recordset(v_payouts) as payout(id uuid,coins integer,place integer);
  end if;
 end loop;
end;
$$;

create or replace function bootcamp_private.ranking_state(p_day date,p_week date)
returns jsonb language sql stable set search_path='' as $$
 with season as (
  select bootcamp_private.season_start(p_day) as start
 ), prior as (
  select start,(start-interval '2 months')::date as previous_start from season
 ), previous as (
  select prior.*,s.payouts,
   case when s.payouts is null then bootcamp_private.standings(previous_start,start-1) end as standings
  from prior left join bootcamp_private.season_coin_settlements s on s.season_start=previous_start
 )
 select jsonb_build_object(
  'season',jsonb_build_object(
   'start',start,'end',(start+interval '2 months')::date-1,
   'previousStart',previous_start,'previousEnd',start-1,
   'prizes',(select prizes from bootcamp_private.season_coin_policy),
   'previousPayouts',coalesce((select jsonb_agg(entry-'id' order by position)
    from jsonb_array_elements(payouts) with ordinality as rows(entry,position)),'[]'::jsonb),
   'winners',coalesce((
    select jsonb_agg(entry-'id' order by position) from jsonb_array_elements(coalesce(payouts,standings)) with ordinality as rows(entry,position)
    where (payouts is not null and entry->>'place'='1')
       or (payouts is null and (entry->>'points')::bigint>0 and entry->'points'=standings->0->'points')
   ),'[]'::jsonb)
  ),
  'seasonRanking',bootcamp_private.standings(start,p_day),
  'allTimeRanking',bootcamp_private.standings('-infinity'::date,p_day),
  'ranking',bootcamp_private.standings(p_week,p_day),
  'monthlyRanking',bootcamp_private.standings(date_trunc('month',p_day)::date,p_day)
 ) from previous;
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
 select photo_bonus into v_bonus from bootcamp_private.workout_finishes where user_id=p_user and day=v_day;
 return v_state || jsonb_build_object(
  'workoutFinished',v_bonus is not null,
  'photoBonus',coalesce(v_bonus,0),
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day' order by s.turn)
   from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
 );
end;
$$;

create extension if not exists pg_cron;
-- 22:05 and 23:05 UTC cover midnight in Berlin in summer and winter.
select cron.schedule('bootcamp-season-coins','5 22,23 * * *',
 'select bootcamp_private.settle_season_coins(bootcamp_private.today());');

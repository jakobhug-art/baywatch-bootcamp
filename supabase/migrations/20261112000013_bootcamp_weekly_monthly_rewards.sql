create function bootcamp_private.weekly_points(p_difficulty text)
returns integer language sql immutable set search_path='' as $$
 select case p_difficulty when 'Leicht' then 45 when 'Mittel' then 60 when 'Schwer' then 75 end
$$;

create function bootcamp_private.apply_weekly_points()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='weekly' then
  new.data:=new.data||jsonb_build_object('points',bootcamp_private.weekly_points(new.data->>'difficulty'));
 end if;
 return new;
end;
$$;
create trigger apply_weekly_points before insert or update on bootcamp_private.challenge_catalog
for each row execute function bootcamp_private.apply_weekly_points();

update bootcamp_private.challenge_catalog
set data=data||jsonb_build_object('difficulty',case
 when data->>'category'='Ernährung' then 'Leicht'
 when id in ('run','walk','cycle','balance','mobility','friend','pool-0-0','pool-0-2','pool-0-3','pool-0-8','pool-0-9','pool-0-12','pool-2-0','pool-2-1','pool-2-2','pool-2-5','pool-2-9') then 'Mittel'
 else coalesce(data->>'difficulty','Mittel') end)
where kind='weekly';

update bootcamp_private.challenge_catalog
set data=data||'{"name":"5 km joggen","hint":"Jogge fünf Kilometer in deinem Tempo.","difficulty":"Mittel"}'::jsonb
where id='run' and kind='weekly';

insert into bootcamp_private.challenge_catalog(id,kind,data) values
 ('run-3km','weekly','{"id":"run-3km","icon":"↗","name":"3 km joggen","hint":"Jogge drei Kilometer in deinem Tempo.","color":"pink","category":"Bewegung","difficulty":"Leicht"}'),
 ('run-7km','weekly','{"id":"run-7km","icon":"↗","name":"7 km joggen","hint":"Jogge mindestens sieben Kilometer in deinem Tempo.","color":"pink","category":"Bewegung","difficulty":"Schwer"}')
on conflict(id) do nothing;

create table bootcamp_private.monthly_bonus_policy(
 starts_on date primary key,
 points integer not null check(points>0)
);
alter table bootcamp_private.monthly_bonus_policy enable row level security;
insert into bootcamp_private.monthly_bonus_policy values(date_trunc('month',bootcamp_private.today())::date,250);

create function bootcamp_private.monthly_bonus(p_day date)
returns integer language sql stable set search_path='' as $$
 select coalesce((select points from bootcamp_private.monthly_bonus_policy where starts_on<=p_day order by starts_on desc limit 1),100)
$$;

create or replace function bootcamp_private.current_deck(p_at timestamptz default now())
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_day date := (p_at at time zone 'Europe/Berlin')::date;
  v_week date := v_day - (extract(isodow from v_day)::integer - 1);
  v_daily jsonb;
  v_weekly jsonb;
  v_previous jsonb;
begin
  select data into v_daily from bootcamp_private.challenge_periods where period = v_day and kind = 'daily';
  if v_daily is null then
    insert into bootcamp_private.challenge_periods (period, kind, data)
    select v_day, 'daily', coalesce(jsonb_agg(data order by (case id when 'push' then 1 when 'plank' then 2 when 'pull' then 3 when 'situp' then 4 when 'squat' then 5 else 6 end), id), '[]'::jsonb)
    from bootcamp_private.challenge_catalog where kind = 'daily' and enabled
    on conflict do nothing;
    select data into v_daily from bootcamp_private.challenge_periods where period = v_day and kind = 'daily';
  end if;
  select data into v_weekly from bootcamp_private.challenge_periods where period = v_week and kind = 'weekly';
  if v_weekly is null then
    select data into v_previous from bootcamp_private.challenge_periods
    where kind = 'weekly' and period < v_week order by period desc limit 1;
    insert into bootcamp_private.challenge_periods (period, kind, data)
    select v_week, 'weekly', coalesce(jsonb_agg(
      jsonb_build_array(c.data->>'id', c.data->>'icon', c.data->>'name', c.data->>'hint',
        c.data->'points', c.data->>'color', groups.name, c.data->>'difficulty') order by groups.position
    ), '[]'::jsonb)
    from (values ('Bewegung',1), ('Ernährung',2), ('Spaß & Abwechslung',3)) groups(name,position)
    cross join lateral (
      select catalog.data from bootcamp_private.challenge_catalog catalog
      where catalog.kind = 'weekly' and catalog.enabled and catalog.data->>'category' = groups.name
      order by exists(select 1 from jsonb_array_elements(coalesce(v_previous,'[]'::jsonb)) old where old->>0 = catalog.id), random()
      limit 1
    ) c
    on conflict do nothing;
    select data into v_weekly from bootcamp_private.challenge_periods where period = v_week and kind = 'weekly';
  end if;
  return jsonb_build_object('day',v_day,'week',v_week,'month',to_char(v_day,'YYYY-MM'),
    'daily',v_daily,'weekly',v_weekly,'monthTarget',12,'monthBonus',bootcamp_private.monthly_bonus(v_day));
end;
$$;

create or replace view bootcamp_private.point_events as
select user_id,day,'exercise:'||exercise as event,points from bootcamp_private.effective_quantities
union all select user_id,earned_on,'weekly:'||exercise,points from bootcamp_private.marks
union all select user_id,day,'wheel:'||turn,case when completed then reward else initial end from bootcamp_private.wheel_spins
union all
select user_id,day,'monthly',bootcamp_private.monthly_bonus(day) from (
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

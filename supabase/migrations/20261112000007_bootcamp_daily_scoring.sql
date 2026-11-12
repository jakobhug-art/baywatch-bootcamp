create function bootcamp_private.exercise_points(p_card jsonb,p_amount integer)
returns integer language sql immutable set search_path='' as $$
 select case when p_card ? 'goalPoints' then
   least(p_amount,target)*goal_points/target
   + least(greatest(p_amount-target,0),target)*goal_points/(4*target)
  else least(p_amount,target)/step + least(least(greatest(p_amount-target,0),target)/(4*step),(target/step)/4)
 end
 from (select (p_card->>'target')::integer as target,(p_card->>'step')::integer as step,
  (p_card->>'goalPoints')::integer as goal_points) values_from_card
$$;

update bootcamp_private.challenge_catalog c
set data=c.data||jsonb_build_object('target',goals.target,'step',goals.step,'goalPoints',60)
from (values ('push',60,1),('plank',240,5),('pull',6,1),('situp',60,1),('squat',80,1)) goals(id,target,step)
where c.kind='daily' and c.id=goals.id;

update bootcamp_private.challenge_catalog set data=data||'{"goalPoints":60}'::jsonb where kind='daily';

-- Keep previous days as scored. Apply the new targets to the current day.
update bootcamp_private.challenge_periods p
set data=(
 select jsonb_agg(card.data||'{"goalPoints":60}'::jsonb||
  case when goals.id is null then '{}'::jsonb else jsonb_build_object('target',goals.target,'step',goals.step) end
  order by card.position)
 from jsonb_array_elements(p.data) with ordinality card(data,position)
 left join (values ('push',60,1),('plank',240,5),('pull',6,1),('situp',60,1),('squat',80,1)) goals(id,target,step)
  on goals.id=card.data->>'id'
)
where p.kind='daily' and p.period=bootcamp_private.today();

update bootcamp_private.quantities q
set points=bootcamp_private.exercise_points(card,q.amount),reached=q.amount>=(card->>'target')::integer
from bootcamp_private.challenge_periods p cross join lateral jsonb_array_elements(p.data) card
where p.kind='daily' and p.period=bootcamp_private.today() and q.day=p.period and q.exercise=card->>'id';

create or replace function public.bootcamp_save_quantity(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_deck jsonb := bootcamp_private.current_deck();
 v_card jsonb;
begin
 perform bootcamp_private.check_day(p_day);
 select card into v_card from jsonb_array_elements(v_deck->'daily') card where card->>'id'=p_exercise;
 if v_card is null or p_amount is null or p_amount not between 0 and 10000 then
  raise sqlstate 'PT400' using message='Wähle eine Tagesübung und gib eine ganze Zahl zwischen 0 und 10.000 ein.';
 end if;
 insert into bootcamp_private.quantities(user_id,day,exercise,amount,points,reached)
 values(p_user,p_day,p_exercise,p_amount,bootcamp_private.exercise_points(v_card,p_amount),p_amount>=(v_card->>'target')::integer)
 on conflict(user_id,day,exercise) do update set amount=excluded.amount,points=excluded.points,reached=excluded.reached;
end;
$$;

create or replace view bootcamp_private.effective_quantities as
select q.* from bootcamp_private.quantities q
where not exists (select 1 from bootcamp_private.rest_days r where r.user_id=q.user_id and r.day=q.day)
union all
select r.user_id,r.day,card->>'id',
 greatest((card->>'target')::integer,coalesce(q.amount,0)),
 greatest(bootcamp_private.exercise_points(card,(card->>'target')::integer),coalesce(q.points,0)),true
from bootcamp_private.rest_days r
join bootcamp_private.challenge_periods p on p.period=r.day and p.kind='daily'
cross join lateral jsonb_array_elements(p.data) card
left join bootcamp_private.quantities q on q.user_id=r.user_id and q.day=r.day and q.exercise=card->>'id';

create function bootcamp_private.daily_goal_points()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='daily' then new.data:=new.data||'{"goalPoints":60}'::jsonb; end if;
 return new;
end;
$$;
create trigger daily_goal_points before insert or update on bootcamp_private.challenge_catalog
for each row execute function bootcamp_private.daily_goal_points();

create table bootcamp_private.daily_penalty_policy (
 starts_on date primary key,
 points_per_missing integer not null check(points_per_missing>0)
);
alter table bootcamp_private.daily_penalty_policy enable row level security;
insert into bootcamp_private.daily_penalty_policy values(bootcamp_private.today(),10);

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
 bootcamp_private.today()-1, interval '1 day') dates(day)
cross join lateral (
 select data from bootcamp_private.challenge_periods where kind='daily' and period<=dates.day::date
 order by period desc limit 1
) snapshot
cross join lateral (
 select count(*) from bootcamp_private.effective_quantities q where q.user_id=p.id and q.day=dates.day::date and q.reached
) achieved
where achieved.count<jsonb_array_length(snapshot.data);

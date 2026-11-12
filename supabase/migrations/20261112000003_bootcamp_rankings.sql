create view bootcamp_private.effective_quantities as
select q.* from bootcamp_private.quantities q
where not exists (select 1 from bootcamp_private.rest_days r where r.user_id=q.user_id and r.day=q.day)
union all
select r.user_id,r.day,card->>'id',
  greatest((card->>'target')::integer,coalesce(q.amount,0)),
  greatest((card->>'target')::integer/(card->>'step')::integer,coalesce(q.points,0)),true
from bootcamp_private.rest_days r
join bootcamp_private.challenge_periods p on p.period=r.day and p.kind='daily'
cross join lateral jsonb_array_elements(p.data) card
left join bootcamp_private.quantities q on q.user_id=r.user_id and q.day=r.day and q.exercise=card->>'id';

create view bootcamp_private.completed_days as
select q.user_id,q.day
from bootcamp_private.effective_quantities q
join bootcamp_private.challenge_periods p on p.period=q.day and p.kind='daily'
where q.reached
group by q.user_id,q.day,p.data
having count(*)=jsonb_array_length(p.data);

create view bootcamp_private.point_events as
select user_id,day,'exercise:'||exercise as event,points from bootcamp_private.effective_quantities
union all select user_id,earned_on,'weekly:'||exercise,points from bootcamp_private.marks
union all select user_id,day,'wheel:'||turn,case when completed then reward else initial end from bootcamp_private.wheel_spins
union all
select user_id,day,'monthly',100 from (
 select user_id,day,row_number() over(partition by user_id,date_trunc('month',day) order by day) as position
 from bootcamp_private.completed_days
) days where position=12;

create function bootcamp_private.standings(p_from date,p_to date)
returns jsonb language sql stable set search_path = '' as $$
 with latest_reset as (
  select id,day from bootcamp_private.point_resets where day<=p_to order by id desc limit 1
 ), scores as (
  select e.user_id,sum(case when baseline.event is null then e.points else greatest(0,e.points-baseline.points) end) as points
  from bootcamp_private.point_events e
  left join latest_reset reset on true
  left join bootcamp_private.point_reset_entries baseline on baseline.reset_id=reset.id and baseline.user_id=e.user_id and baseline.event=e.event and e.day=reset.day
  where e.day between p_from and p_to and (reset.day is null or e.day>=reset.day)
  group by e.user_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('handle',p.handle,'points',coalesce(scores.points,0))
  order by coalesce(scores.points,0) desc,lower(p.handle)), '[]'::jsonb)
 from bootcamp_private.profiles p left join scores on scores.user_id=p.id;
$$;

create function bootcamp_private.ranking_state(p_day date,p_week date)
returns jsonb language sql stable set search_path = '' as $$
 with season as (
  select make_date(extract(year from p_day)::integer,((extract(month from p_day)::integer-1)/2)*2+1,1) as start
 ), prior as (
  select start,bootcamp_private.standings((start-interval '2 months')::date,start-1) as standings from season
 )
 select jsonb_build_object(
  'season',jsonb_build_object(
   'start',start,'end',(start+interval '2 months')::date-1,
   'previousStart',(start-interval '2 months')::date,'previousEnd',start-1,
   'winners',coalesce((select jsonb_agg(row) from jsonb_array_elements(standings) row
     where (row->>'points')::integer>0 and row->'points'=standings->0->'points'),'[]'::jsonb)
  ),
  'seasonRanking',bootcamp_private.standings(start,p_day),
  'allTimeRanking',bootcamp_private.standings('-infinity'::date,p_day),
  'ranking',bootcamp_private.standings(p_week,p_day),
  'monthlyRanking',bootcamp_private.standings(date_trunc('month',p_day)::date,p_day)
 ) from prior;
$$;

create or replace function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deck jsonb := bootcamp_private.current_deck();
  v_day date := (v_deck->>'day')::date;
  v_week date := (v_deck->>'week')::date;
  v_profile jsonb;
begin
  select jsonb_build_object('id',id,'handle',handle,'admin',is_admin) into v_profile
  from bootcamp_private.profiles where id=p_user;
  return jsonb_build_object(
    'deck',v_deck,
    'user',v_profile,
    'quantities',coalesce((select jsonb_agg(jsonb_build_object('exercise',exercise,'amount',amount,'points',points))
      from bootcamp_private.quantities where user_id=p_user and day=v_day),'[]'::jsonb),
    'marks',coalesce((select jsonb_agg(jsonb_build_object('exercise',exercise))
      from bootcamp_private.marks where user_id=p_user and week=v_week),'[]'::jsonb),
    'activeDays',coalesce((select jsonb_agg(day order by day) from bootcamp_private.completed_days
      where user_id=p_user and day between date_trunc('month',v_day)::date and v_day),'[]'::jsonb)
  ) || case when v_profile is null then '{}'::jsonb else bootcamp_private.ranking_state(v_day,v_week) end;
end;
$$;

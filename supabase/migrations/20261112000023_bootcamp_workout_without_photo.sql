alter table bootcamp_private.workout_finishes drop constraint workout_finishes_photo_bonus_check;
alter table bootcamp_private.workout_finishes add constraint workout_finishes_photo_bonus_check
 check (photo_bonus in (-20,0,10));

create function public.bootcamp_finish_without_photo(p_user uuid,p_day date)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then
  raise sqlstate 'PT403' using message='Registrierung erforderlich.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 if exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  return;
 end if;
 perform public.bootcamp_finish_workout(p_user,p_day);
 update bootcamp_private.workout_finishes set photo_bonus=-20 where user_id=p_user and day=p_day;
end;
$$;
revoke all on function public.bootcamp_finish_without_photo(uuid,date) from public,anon,authenticated;
grant execute on function public.bootcamp_finish_without_photo(uuid,date) to service_role;

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
   or exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=p.id and f.day=dates.day::date))
union all select user_id,day,'workout_photo',photo_bonus
from bootcamp_private.workout_finishes where photo_bonus<>0;

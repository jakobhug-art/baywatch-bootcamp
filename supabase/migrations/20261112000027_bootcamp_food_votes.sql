create table bootcamp_private.food_polls (
 id uuid primary key,
 reporter uuid not null references bootcamp_private.profiles on delete cascade,
 target uuid not null references bootcamp_private.profiles on delete cascade,
 created_at timestamptz not null default now(),
 resolved_on date,
 verdict boolean,
 photo bytea check (octet_length(photo) between 4 and 160000),
 check (reporter<>target),
 check ((resolved_on is null)=(verdict is null))
);
create index food_polls_created on bootcamp_private.food_polls(created_at desc);
create table bootcamp_private.food_ballots (
 poll uuid not null references bootcamp_private.food_polls on delete cascade,
 voter uuid not null references bootcamp_private.profiles on delete cascade,
 guilty boolean,
 primary key(poll,voter)
);
alter table bootcamp_private.food_polls enable row level security;
alter table bootcamp_private.food_ballots enable row level security;

create function public.bootcamp_open_food_poll(p_user uuid,p_id uuid,p_target uuid,p_photo text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 if p_target is null or p_user=p_target or not public.bootcamp_has_profile(p_target) then
  raise sqlstate 'PT400' using message='Wähle ein anderes Gruppenmitglied.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_target::text,27));
 if exists(select 1 from bootcamp_private.food_polls where id=p_id and reporter=p_user and target=p_target) then return; end if;
 if exists(select 1 from bootcamp_private.food_polls where target=p_target and verdict is null and created_at>now()-interval '7 days') then
  raise sqlstate 'PT409' using message='Für dieses Mitglied läuft bereits eine Abstimmung.';
 end if;
 update bootcamp_private.food_polls set photo=null where photo is not null and created_at<=now()-interval '7 days';
 insert into bootcamp_private.food_polls(id,reporter,target,photo) values(p_id,p_user,p_target,decode(p_photo,'base64'));
 insert into bootcamp_private.food_ballots(poll,voter)
 select p_id,id from bootcamp_private.profiles where id<>p_target;
end;
$$;

create function public.bootcamp_vote_food_poll(p_user uuid,p_id uuid,p_guilty boolean)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_poll bootcamp_private.food_polls%rowtype;
 v_yes integer;
 v_no integer;
 v_majority integer;
begin
 if p_guilty is null then raise sqlstate 'PT400' using message='Wähle eine Stimme.'; end if;
 select * into v_poll from bootcamp_private.food_polls where id=p_id for update;
 if not found then raise sqlstate 'PT404' using message='Abstimmung nicht gefunden.'; end if;
 if not exists(select 1 from bootcamp_private.food_ballots where poll=p_id and voter=p_user) then
  raise sqlstate 'PT403' using message='Du bist bei dieser Abstimmung nicht stimmberechtigt.';
 end if;
 if exists(select 1 from bootcamp_private.food_ballots where poll=p_id and voter=p_user and guilty=p_guilty) then return; end if;
 if v_poll.verdict is not null or v_poll.created_at<=now()-interval '7 days' then
  raise sqlstate 'PT409' using message='Die Abstimmung ist abgeschlossen.';
 end if;
 update bootcamp_private.food_ballots set guilty=p_guilty where poll=p_id and voter=p_user and guilty is null;
 if not found then raise sqlstate 'PT409' using message='Deine Stimme wurde bereits abgegeben.'; end if;
 select count(*) filter(where guilty),count(*) filter(where not guilty),count(*)/2+1
 into v_yes,v_no,v_majority from bootcamp_private.food_ballots where poll=p_id;
 if v_yes>=v_majority or v_no>=v_majority then
  update bootcamp_private.food_polls set verdict=(v_yes>=v_majority),resolved_on=bootcamp_private.today() where id=p_id;
 end if;
end;
$$;

create function public.bootcamp_food_polls(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(entry)),'[]'::jsonb) from (
  select p.id,t.handle as "targetName",r.handle as "reporterName",p.created_at as "createdAt",
   p.verdict,p.created_at<=now()-interval '7 days' as expired,
   p.photo is not null and p.created_at>now()-interval '7 days' as "hasPhoto",
   count(*) filter(where b.guilty) as yes,count(*) filter(where not b.guilty) as no,
   count(b.voter)/2+1 as majority,
   coalesce(bool_or(b.voter=p_user and b.guilty is null),false) as "canVote",
   bool_or(b.guilty) filter(where b.voter=p_user) as "myVote"
  from bootcamp_private.food_polls p
  join bootcamp_private.profiles t on t.id=p.target join bootcamp_private.profiles r on r.id=p.reporter
  left join bootcamp_private.food_ballots b on b.poll=p.id
  group by p.id,t.handle,r.handle
  order by (p.verdict is null and p.created_at>now()-interval '7 days') desc,p.created_at desc limit 25
 ) entry);
end;
$$;

create function public.bootcamp_food_photo(p_user uuid,p_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return (select encode(photo,'base64') from bootcamp_private.food_polls where id=p_id and created_at>now()-interval '7 days');
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
select p.id,dates.day::date,'daily_penalty',-policy.points_per_missing*(required.count-achieved.count::integer)
from bootcamp_private.profiles p
join auth.users account on account.id=p.id
cross join bootcamp_private.daily_penalty_policy policy
cross join lateral generate_series(greatest(policy.starts_on,(account.created_at at time zone 'Europe/Berlin')::date),
 bootcamp_private.today(), interval '1 day') dates(day)
cross join lateral (
 select data from bootcamp_private.challenge_periods where kind='daily' and period<=dates.day::date
 order by period desc limit 1
) snapshot
cross join lateral (select jsonb_array_length(bootcamp_private.scored_daily(p.id,dates.day::date,snapshot.data)) as count) required
cross join lateral (
 select count(*) from bootcamp_private.effective_quantities q where q.user_id=p.id and q.day=dates.day::date and q.reached
) achieved
where achieved.count<required.count
 and (dates.day::date<bootcamp_private.today()
   or exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=p.id and f.day=dates.day::date))
union all select user_id,day,'workout_photo',photo_bonus from bootcamp_private.workout_finishes where photo_bonus<>0
union all select target,resolved_on,'food_vote:'||id,-30 from bootcamp_private.food_polls where verdict;

revoke all on function public.bootcamp_open_food_poll(uuid,uuid,uuid,text),public.bootcamp_vote_food_poll(uuid,uuid,boolean),
 public.bootcamp_food_polls(uuid),public.bootcamp_food_photo(uuid,uuid) from public,anon,authenticated;
grant execute on function public.bootcamp_open_food_poll(uuid,uuid,uuid,text),public.bootcamp_vote_food_poll(uuid,uuid,boolean),
 public.bootcamp_food_polls(uuid),public.bootcamp_food_photo(uuid,uuid) to service_role;

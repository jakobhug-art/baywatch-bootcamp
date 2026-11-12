alter table bootcamp_private.workout_finishes
 add column photo_bonus integer not null default 0 check (photo_bonus in (0,10));

create or replace function public.bootcamp_finish_with_photo(p_user uuid,p_day date,p_path text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then
  raise sqlstate 'PT403' using message='Registrierung erforderlich.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 if exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  return false;
 end if;
 perform public.bootcamp_finish_workout(p_user,p_day);
 update bootcamp_private.workout_finishes set photo_bonus=10 where user_id=p_user and day=p_day;
 insert into bootcamp_private.workout_photos(user_id,day,object_path) values(p_user,p_day,p_path);
 return true;
end;
$$;

create or replace function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb := bootcamp_private.bootcamp_training_state(p_user);
 v_day date := (v_state->'deck'->>'day')::date;
 v_bonus integer;
begin
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

create function public.bootcamp_member_gallery(p_user uuid,p_member uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'day',p.day,'handle',m.handle) order by p.day desc),'[]'::jsonb)
 from bootcamp_private.workout_photos p join bootcamp_private.profiles m on m.id=p.user_id
 where public.bootcamp_has_profile(p_user) and p.user_id=p_member
   and p.day>=bootcamp_private.season_start(bootcamp_private.today());
$$;

create table bootcamp_private.media_backups(
 id uuid primary key default gen_random_uuid(),
 admin_id uuid not null references bootcamp_private.profiles on delete cascade,
 season date not null,
 files jsonb not null,
 created_at timestamptz not null default now()
);
alter table bootcamp_private.media_backups enable row level security;

create function public.bootcamp_prepare_media_backup(p_admin uuid,p_season date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_files jsonb;
 v_id uuid;
begin
 perform bootcamp_private.require_admin(p_admin);
 if p_season is null or p_season<>bootcamp_private.season_start(p_season)
  or p_season>bootcamp_private.season_start(bootcamp_private.today()) then
  raise sqlstate 'PT400' using message='Wähle eine gültige Season.';
 end if;
 select coalesce(jsonb_agg(to_jsonb(entry) order by entry.bucket,entry.path),'[]'::jsonb) into v_files
 from (
  select bucket,path,filename from bootcamp_private.season_media
  where day>=p_season and day<(p_season+interval '2 months')::date
 ) entry;
 if jsonb_array_length(v_files)=0 then
  raise sqlstate 'PT404' using message='Für diese Season gibt es keine Dateien.';
 end if;
 delete from bootcamp_private.media_backups where created_at<now()-interval '7 days';
 insert into bootcamp_private.media_backups(admin_id,season,files)
 values(p_admin,p_season,v_files) returning id into v_id;
 return jsonb_build_object('backupId',v_id,'files',v_files);
end;
$$;

create function bootcamp_private.backed_up_files(p_admin uuid,p_backup uuid,p_bucket text)
returns table(bucket text,path text)
language sql stable set search_path='' as $$
 select f->>'bucket',f->>'path'
 from bootcamp_private.media_backups b cross join lateral jsonb_array_elements(b.files) f
 where b.id=p_backup and b.admin_id=p_admin and b.created_at>=now()-interval '7 days'
   and (p_bucket is null or f->>'bucket'=p_bucket)
$$;

create function public.bootcamp_media_backup_batch(p_admin uuid,p_backup uuid,p_bucket text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_admin);
 if not exists(select 1 from bootcamp_private.media_backups where id=p_backup and admin_id=p_admin
               and created_at>=now()-interval '7 days') then
  raise sqlstate 'PT404' using message='Die Sicherung ist abgelaufen. Erstelle ein neues ZIP.';
 end if;
 return (
  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.bucket,entry.path),'[]'::jsonb)
  from (
   select b.bucket,b.path from bootcamp_private.backed_up_files(p_admin,p_backup,p_bucket) b
   join bootcamp_private.season_media m on m.bucket=b.bucket and m.path=b.path
   order by b.bucket,b.path limit 61
  ) entry
 );
end;
$$;

create function public.bootcamp_remove_backed_up_media(p_admin uuid,p_backup uuid,p_bucket text,p_paths text[])
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_admin);
 if p_bucket='bootcamp-workouts' then
  delete from bootcamp_private.workout_photos p using bootcamp_private.backed_up_files(p_admin,p_backup,p_bucket) b
  where p.object_path=b.path and p.object_path=any(p_paths);
 elsif p_bucket='bootcamp-voice' then
  delete from bootcamp_private.pranks p using bootcamp_private.backed_up_files(p_admin,p_backup,p_bucket) b
  where p.kind='voice' and p.audio_path=b.path and p.audio_path=any(p_paths);
 end if;
end;
$$;

revoke all on function public.bootcamp_member_gallery(uuid,uuid),public.bootcamp_prepare_media_backup(uuid,date),
 public.bootcamp_media_backup_batch(uuid,uuid,text),public.bootcamp_remove_backed_up_media(uuid,uuid,text,text[])
 from public,anon,authenticated;
grant execute on function public.bootcamp_member_gallery(uuid,uuid),public.bootcamp_prepare_media_backup(uuid,date),
 public.bootcamp_media_backup_batch(uuid,uuid,text),public.bootcamp_remove_backed_up_media(uuid,uuid,text,text[])
 to service_role;

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
from bootcamp_private.workout_finishes where photo_bonus>0;

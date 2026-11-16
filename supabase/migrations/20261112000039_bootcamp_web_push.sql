create extension if not exists pg_net with schema extensions;

create table bootcamp_private.push_devices (
 id bigint generated always as identity primary key,
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 endpoint text not null unique,
 p256dh text not null,
 auth_key text not null
);
create index push_devices_user on bootcamp_private.push_devices(user_id);
alter table bootcamp_private.push_devices enable row level security;

create table bootcamp_private.push_jobs (
 id bigint generated always as identity primary key,
 device_id bigint not null references bootcamp_private.push_devices on delete cascade,
 event_key text not null,
 day date not null,
 kind text not null check(kind in ('reminder','friend','test')),
 body text not null,
 created_at timestamptz not null default now(),
 next_attempt_at timestamptz not null default now(),
 attempts integer not null default 0,
 finished_at timestamptz,
 unique(device_id,event_key)
);
create index push_jobs_due on bootcamp_private.push_jobs(next_attempt_at) where finished_at is null;
alter table bootcamp_private.push_jobs enable row level security;

create function public.bootcamp_push_device(p_user uuid,p_action text,p_endpoint text,p_p256dh text default null,p_auth text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_device bigint;
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 if p_action='enable' then
  perform pg_advisory_xact_lock(hashtextextended(p_endpoint,39));
  delete from bootcamp_private.push_devices where endpoint=p_endpoint and user_id<>p_user;
  insert into bootcamp_private.push_devices(user_id,endpoint,p256dh,auth_key)
  values(p_user,p_endpoint,p_p256dh,p_auth)
  on conflict(endpoint) do update set p256dh=excluded.p256dh,auth_key=excluded.auth_key;
 elsif p_action='disable' then
  delete from bootcamp_private.push_devices where endpoint=p_endpoint and user_id=p_user;
 elsif p_action='test' then
  select id into v_device from bootcamp_private.push_devices where endpoint=p_endpoint and user_id=p_user;
  if not found then raise sqlstate 'PT409' using message='Aktiviere Push zuerst auf diesem Gerät.'; end if;
  insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
  values(v_device,'test:'||floor(extract(epoch from now())/60)::text,bootcamp_private.today(),'test','Push-Nachrichten sind auf diesem Gerät aktiv.')
  on conflict do nothing;
 end if;
 return jsonb_build_object('active',exists(select 1 from bootcamp_private.push_devices where endpoint=p_endpoint and user_id=p_user));
end;
$$;

create function bootcamp_private.enqueue_friend_push()
returns trigger language plpgsql set search_path='' as $$
begin
 insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
 select d.id,'friend:'||new.day::text||':'||new.user_id::text,new.day,'friend',p.handle||' hat das Workout abgeschlossen.'
 from bootcamp_private.push_devices d
 join bootcamp_private.profile_settings settings on settings.user_id=d.user_id and settings.friend_notifications
 join bootcamp_private.profiles p on p.id=new.user_id
 where d.user_id<>new.user_id and new.day=bootcamp_private.today()
 on conflict do nothing;
 return new;
end;
$$;

create trigger enqueue_friend_push after insert on bootcamp_private.workout_finishes
for each row execute function bootcamp_private.enqueue_friend_push();

create view bootcamp_private.pending_push as
select j.id,j.device_id,j.kind,j.body,j.attempts,d.endpoint,d.p256dh,d.auth_key
from bootcamp_private.push_jobs j
join bootcamp_private.push_devices d on d.id=j.device_id
left join bootcamp_private.profile_settings s on s.user_id=d.user_id
where j.finished_at is null and j.next_attempt_at<=now() and j.attempts<3 and (
 (j.kind='test' and j.created_at>now()-interval '10 minutes') or
 (j.day=bootcamp_private.today() and (
  (j.kind='friend' and s.friend_notifications) or
  (j.kind='reminder' and s.workout_reminders
   and not exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=d.user_id and f.day=j.day)
   and not exists(select 1 from bootcamp_private.rest_days r where r.user_id=d.user_id and r.day=j.day))
 ))
);

create function public.bootcamp_claim_push_jobs()
returns jsonb language sql security definer set search_path='' as $$
 with pending as materialized (
  select p.* from bootcamp_private.pending_push p join bootcamp_private.push_jobs j on j.id=p.id
  order by j.id limit 32 for update of j skip locked
 ), claimed as (
  update bootcamp_private.push_jobs j set attempts=j.attempts+1,next_attempt_at=now()+interval '2 minutes'
  from pending p where j.id=p.id and j.attempts=p.attempts and j.next_attempt_at<=now()
  returning j.id::text as id,j.device_id::text as "deviceId",j.kind,j.body,j.attempts,p.endpoint,p.p256dh,p.auth_key as auth
 )
 select coalesce(jsonb_agg(claimed),'[]'::jsonb) from claimed
$$;

create function public.bootcamp_finish_push_job(p_id bigint,p_attempt integer,p_result text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_result='expired' then
  delete from bootcamp_private.push_devices d using bootcamp_private.push_jobs j
  where j.id=p_id and j.attempts=p_attempt and j.device_id=d.id;
 elsif p_result='finished' then
  update bootcamp_private.push_jobs set finished_at=now() where id=p_id and attempts=p_attempt;
 end if;
end;
$$;

create function bootcamp_private.tick_push()
returns void language plpgsql set search_path='' as $$
declare
 v_day date:=bootcamp_private.today();
 v_now timestamp:=now() at time zone 'Europe/Berlin';
 v_url text;
 v_secret text;
begin
 insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
 select d.id,'reminder:'||v_day::text,v_day,'reminder','Dein Workout für heute ist noch offen.'
 from bootcamp_private.push_devices d join bootcamp_private.profile_settings s on s.user_id=d.user_id
 where s.workout_reminders and v_now>=v_day+s.reminder_time and v_now<v_day+s.reminder_time+interval '10 minutes'
 and not exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=d.user_id and f.day=v_day)
 and not exists(select 1 from bootcamp_private.rest_days r where r.user_id=d.user_id and r.day=v_day)
 on conflict do nothing;

 delete from bootcamp_private.push_jobs where day<v_day-7;
 if not exists(select 1 from bootcamp_private.pending_push) then return; end if;
 select decrypted_secret into v_url from vault.decrypted_secrets where name='bootcamp_push_url';
 select decrypted_secret into v_secret from vault.decrypted_secrets where name='bootcamp_push_cron_secret';
 if v_url is null or v_secret is null then return; end if;
 perform net.http_post(url:=v_url,headers:=jsonb_build_object('Content-Type','application/json','x-bootcamp-push-secret',v_secret),
  body:='{}'::jsonb,timeout_milliseconds:=25000);
end;
$$;

revoke all on function public.bootcamp_push_device(uuid,text,text,text,text),public.bootcamp_claim_push_jobs(),
 public.bootcamp_finish_push_job(bigint,integer,text) from public,anon,authenticated;
grant execute on function public.bootcamp_push_device(uuid,text,text,text,text),public.bootcamp_claim_push_jobs(),
 public.bootcamp_finish_push_job(bigint,integer,text) to service_role;
select cron.schedule('bootcamp-web-push','* * * * *','select bootcamp_private.tick_push()');

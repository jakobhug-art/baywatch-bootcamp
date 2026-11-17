alter table bootcamp_private.profile_settings add column morning_reminder boolean not null default false;
update bootcamp_private.profile_settings set morning_reminder=true where workout_reminders;

create or replace function public.bootcamp_profile_settings(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return coalesce((select jsonb_build_object('birthDate',birth_date,'birthdayMonthDay',known_month_day,
  'showBirthday',show_birthday,'workoutReminders',workout_reminders,'reminderTime',to_char(reminder_time,'HH24:MI'),
  'morningReminder',morning_reminder,'eveningReminder',workout_reminders,'friendNotifications',friend_notifications)
  from bootcamp_private.profile_settings where user_id=p_user),
  '{"birthDate":null,"birthdayMonthDay":null,"showBirthday":true,"workoutReminders":false,"reminderTime":"18:00",
    "morningReminder":false,"eveningReminder":false,"friendNotifications":false}'::jsonb);
end;
$$;

create function public.bootcamp_save_fixed_push_profile(p_user uuid,p_birth date,p_show boolean,p_morning boolean,p_evening boolean,p_friends boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.bootcamp_save_profile_settings(p_user,p_birth,p_show,p_evening,p_friends,time '18:00');
 update bootcamp_private.profile_settings set morning_reminder=p_morning where user_id=p_user;
 return public.bootcamp_profile_settings(p_user);
end;
$$;

create or replace view bootcamp_private.pending_push as
select j.id,j.device_id,j.kind,j.body,j.attempts,d.endpoint,d.p256dh,d.auth_key
from bootcamp_private.push_jobs j
join bootcamp_private.push_devices d on d.id=j.device_id
left join bootcamp_private.profile_settings s on s.user_id=d.user_id
where j.finished_at is null and j.next_attempt_at<=now() and j.attempts<3 and (
 (j.kind='test' and j.created_at>now()-interval '10 minutes') or
 (j.day=bootcamp_private.today() and (
  (j.kind='friend' and s.friend_notifications) or
  (j.kind='reminder' and ((j.event_key='morning:'||j.day::text and s.morning_reminder)
   or (j.event_key='evening:'||j.day::text and s.workout_reminders)))
 ))
);

create or replace function bootcamp_private.tick_push()
returns void language plpgsql set search_path='' as $$
declare
 v_day date:=bootcamp_private.today();
 v_now timestamp:=now() at time zone 'Europe/Berlin';
 v_url text;
 v_secret text;
begin
 insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
 select d.id,slot.name||':'||v_day::text,v_day,'reminder',slot.message
 from bootcamp_private.push_devices d join bootcamp_private.profile_settings s on s.user_id=d.user_id
 cross join lateral (values
  ('morning',time '06:00',s.morning_reminder,'Starte den Morgen mit einer Aktivität'),
  ('evening',time '18:00',s.workout_reminders,'Vergiss deine Übungen nicht')
 ) as slot(name,starts_at,enabled,message)
 where slot.enabled and v_now>=v_day+slot.starts_at and v_now<v_day+slot.starts_at+interval '10 minutes'
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

alter table bootcamp_private.push_jobs add column delivery_result text check(delivery_result in ('accepted','failed'));

create function public.bootcamp_finish_push_job(p_id bigint,p_attempt integer,p_result text,p_provider_status integer)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_result='expired' then
  perform public.bootcamp_finish_push_job(p_id,p_attempt,'expired');
 elsif p_result in ('accepted','failed') or (p_result='retry' and p_attempt>=3) then
  update bootcamp_private.push_jobs set finished_at=now(),
   delivery_result=case when p_result='accepted' and p_provider_status between 200 and 299 then 'accepted' else 'failed' end
  where id=p_id and attempts=p_attempt;
 end if;
end;
$$;

create function public.bootcamp_push_test_status(p_user uuid,p_endpoint text)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce((
  select jsonb_build_object('state',coalesce(j.delivery_result,'pending'),'tag','bootcamp-'||j.id::text)
  from bootcamp_private.push_devices d join bootcamp_private.push_jobs j on j.device_id=d.id
  where d.user_id=p_user and d.endpoint=p_endpoint and j.kind='test' and j.created_at>now()-interval '10 minutes'
  order by j.id desc limit 1
 ),jsonb_build_object('state','missing'))
$$;

revoke all on function public.bootcamp_save_fixed_push_profile(uuid,date,boolean,boolean,boolean,boolean),
 public.bootcamp_finish_push_job(bigint,integer,text,integer),public.bootcamp_push_test_status(uuid,text) from public,anon,authenticated;
grant execute on function public.bootcamp_save_fixed_push_profile(uuid,date,boolean,boolean,boolean,boolean),
 public.bootcamp_finish_push_job(bigint,integer,text,integer),public.bootcamp_push_test_status(uuid,text) to service_role;

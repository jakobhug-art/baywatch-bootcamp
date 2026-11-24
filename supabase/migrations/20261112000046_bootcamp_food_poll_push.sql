alter table bootcamp_private.profile_settings add column food_notifications boolean not null default true;
alter table bootcamp_private.push_jobs drop constraint push_jobs_kind_check;
alter table bootcamp_private.push_jobs add constraint push_jobs_kind_check check(kind in ('reminder','friend','test','chat','food'));

create or replace function public.bootcamp_profile_settings(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return coalesce((select jsonb_build_object('birthDate',birth_date,'birthdayMonthDay',known_month_day,
  'showBirthday',show_birthday,'workoutReminders',workout_reminders,'reminderTime',to_char(reminder_time,'HH24:MI'),
  'morningReminder',morning_reminder,'eveningReminder',workout_reminders,'friendNotifications',friend_notifications,
  'chatNotifications',chat_notifications,'foodNotifications',food_notifications)
  from bootcamp_private.profile_settings where user_id=p_user),
  '{"birthDate":null,"birthdayMonthDay":null,"showBirthday":true,"workoutReminders":false,"reminderTime":"18:00",
    "morningReminder":false,"eveningReminder":false,"friendNotifications":false,"chatNotifications":true,"foodNotifications":true}'::jsonb);
end;
$$;

create function public.bootcamp_save_food_push_profile(p_user uuid,p_birth date,p_show boolean,p_morning boolean,p_evening boolean,p_friends boolean,p_chat boolean,p_food boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.bootcamp_save_chat_push_profile(p_user,p_birth,p_show,p_morning,p_evening,p_friends,p_chat);
 update bootcamp_private.profile_settings set food_notifications=p_food where user_id=p_user;
 return public.bootcamp_profile_settings(p_user);
end;
$$;
revoke all on function public.bootcamp_save_food_push_profile(uuid,date,boolean,boolean,boolean,boolean,boolean,boolean) from public,anon,authenticated;
grant execute on function public.bootcamp_save_food_push_profile(uuid,date,boolean,boolean,boolean,boolean,boolean,boolean) to service_role;

create function bootcamp_private.enqueue_food_push()
returns trigger language plpgsql set search_path='' as $$
begin
 insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
 select d.id,'food:'||new.id::text,bootcamp_private.today(),'food',
  'Neue Fettstrafe-Abstimmung zu '||p.handle||'. Schau dir das Beweisfoto an.'
 from bootcamp_private.push_devices d
 join bootcamp_private.profiles p on p.id=new.target
 left join bootcamp_private.profile_settings s on s.user_id=d.user_id
 where d.user_id<>new.reporter and coalesce(s.food_notifications,true)
 on conflict do nothing;
 return new;
end;
$$;
create trigger enqueue_food_push after insert on bootcamp_private.food_polls
for each row execute function bootcamp_private.enqueue_food_push();

create or replace view bootcamp_private.pending_push as
select j.id,j.device_id,j.kind,j.body,j.attempts,d.endpoint,d.p256dh,d.auth_key
from bootcamp_private.push_jobs j
join bootcamp_private.push_devices d on d.id=j.device_id
left join bootcamp_private.profile_settings s on s.user_id=d.user_id
where j.finished_at is null and j.next_attempt_at<=now() and j.attempts<3 and (
 (j.kind='test' and j.created_at>now()-interval '10 minutes') or
 (j.kind='chat' and j.created_at>now()-interval '1 hour' and coalesce(s.chat_notifications,true)) or
 (j.kind='food' and j.created_at>now()-interval '1 hour' and coalesce(s.food_notifications,true)
  and exists(select 1 from bootcamp_private.food_polls p
   where j.event_key='food:'||p.id::text and p.verdict is null and p.created_at>now()-interval '7 days')) or
 (j.day=bootcamp_private.today() and (
  (j.kind='friend' and s.friend_notifications) or
  (j.kind='reminder' and ((j.event_key='morning:'||j.day::text and s.morning_reminder)
   or (j.event_key='evening:'||j.day::text and s.workout_reminders)))
 ))
);

create table bootcamp_private.profile_settings (
 user_id uuid primary key references bootcamp_private.profiles on delete cascade,
 birth_date date,
 known_month_day text check (known_month_day ~ '^[0-9]{2}-[0-9]{2}$'),
 show_birthday boolean not null default true,
 workout_reminders boolean not null default false,
 friend_notifications boolean not null default false,
 reminder_time time not null default '19:00'
);
alter table bootcamp_private.profile_settings enable row level security;

create table bootcamp_private.birthday_tickets (
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 gift_year integer not null,
 day date not null,
 turn integer not null check(turn between 1 and 3),
 symbols smallint[] not null check(cardinality(symbols)=3 and array_position(symbols,null) is null
  and symbols <@ array[1,2,3,15]::smallint[]),
 claimed boolean not null default false,
 primary key(user_id,gift_year,turn)
);
alter table bootcamp_private.birthday_tickets enable row level security;

create function public.bootcamp_profile_settings(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return coalesce((select jsonb_build_object('birthDate',birth_date,'birthdayMonthDay',known_month_day,
  'showBirthday',show_birthday,'workoutReminders',workout_reminders,'friendNotifications',friend_notifications,
  'reminderTime',to_char(reminder_time,'HH24:MI')) from bootcamp_private.profile_settings where user_id=p_user),
  '{"birthDate":null,"birthdayMonthDay":null,"showBirthday":true,"workoutReminders":false,"friendNotifications":false,"reminderTime":"19:00"}'::jsonb);
end;
$$;

create function public.bootcamp_save_profile_settings(p_user uuid,p_birth date,p_show boolean,p_reminders boolean,p_friends boolean,p_time time)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 if p_birth>bootcamp_private.today() or p_birth<date '1900-01-01' then
  raise sqlstate 'PT400' using message='Gib ein gültiges Geburtsdatum ein.';
 end if;
 insert into bootcamp_private.profile_settings(user_id,birth_date,show_birthday,workout_reminders,friend_notifications,reminder_time)
 values(p_user,p_birth,p_show,p_reminders,p_friends,p_time)
 on conflict(user_id) do update set birth_date=excluded.birth_date,show_birthday=excluded.show_birthday,
 workout_reminders=excluded.workout_reminders,friend_notifications=excluded.friend_notifications,reminder_time=excluded.reminder_time;
 return public.bootcamp_profile_settings(p_user);
end;
$$;

create function bootcamp_private.issue_birthday_tickets(p_user uuid,p_symbols jsonb)
returns void language plpgsql set search_path='' as $$
declare
 v_day date:=bootcamp_private.today();
 v_year integer:=extract(year from v_day);
begin
 if not exists(select 1 from bootcamp_private.profile_settings where user_id=p_user
  and coalesce(to_char(birth_date,'MM-DD'),known_month_day)=to_char(v_day,'MM-DD')) then return; end if;
 if exists(select 1 from bootcamp_private.birthday_tickets where user_id=p_user and gift_year=v_year) then return; end if;
 if jsonb_array_length(p_symbols) is distinct from 3 then raise exception 'Expected three birthday tickets'; end if;
 insert into bootcamp_private.birthday_tickets(user_id,gift_year,day,turn,symbols)
 select p_user,v_year,v_day,position,array(select value::smallint from jsonb_array_elements_text(ticket))
 from jsonb_array_elements(p_symbols) with ordinality as items(ticket,position)
 order by position on conflict do nothing;
end;
$$;

create function public.bootcamp_member_state(p_user uuid,p_birthday_symbols jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb;
 v_day date:=bootcamp_private.today();
begin
 if not public.bootcamp_has_profile(p_user) then return '{"user":null}'::jsonb; end if;
 perform bootcamp_private.issue_birthday_tickets(p_user,p_birthday_symbols);
 v_state:=public.bootcamp_training_state(p_user);
 return v_state||jsonb_build_object('birthdays',coalesce((
  select jsonb_agg(p.handle order by lower(p.handle)) from bootcamp_private.profile_settings s
  join bootcamp_private.profiles p on p.id=s.user_id
  where s.show_birthday and coalesce(to_char(s.birth_date,'MM-DD'),s.known_month_day)=to_char(v_day,'MM-DD')
 ),'[]'::jsonb),'scratchTickets',(v_state->'scratchTickets')||coalesce((
  select jsonb_agg(jsonb_build_object('day',day,'turn',turn,'values',symbols,'claimed',claimed,'birthday',true) order by turn)
  from bootcamp_private.birthday_tickets where user_id=p_user and day=v_day
 ),'[]'::jsonb));
end;
$$;

create function public.bootcamp_claim_birthday_ticket(p_user uuid,p_day date,p_turn integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_ticket bootcamp_private.birthday_tickets%rowtype;
 v_prize integer:=0;
begin
 perform bootcamp_private.check_day(p_day);
 select * into v_ticket from bootcamp_private.birthday_tickets where user_id=p_user and gift_year=extract(year from p_day)
  and day=p_day and turn=p_turn for update;
 if not found then raise sqlstate 'PT404' using message='Geburtstagslos nicht gefunden.'; end if;
 if v_ticket.symbols[1]=v_ticket.symbols[2] and v_ticket.symbols[2]=v_ticket.symbols[3] then v_prize:=v_ticket.symbols[1]; end if;
 if not v_ticket.claimed then
  update bootcamp_private.birthday_tickets set claimed=true where user_id=p_user and gift_year=v_ticket.gift_year and turn=p_turn;
  if v_prize>0 then
   insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,v_prize,'Geburtstagslos',p_day);
  end if;
 end if;
 return jsonb_build_object('prize',v_prize);
end;
$$;

create or replace function public.bootcamp_spin_with_ticket(
 p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_values smallint[]
)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_coins integer:=case p_slot when 10 then 15 when 11 then 7 when 12 then 3 else 0 end;
begin
 perform public.bootcamp_spin(p_user,p_day,p_turn,p_slot,p_card,0);
 update bootcamp_private.wheel_spins set scratch_values=p_values where user_id=p_user and day=p_day and turn=p_turn;
 if v_coins>0 then
  insert into bootcamp_private.coin_entries(user_id,amount,label,day)
  values(p_user,v_coins,case p_slot when 10 then 'Glücksrad-Jackpot' else 'Glücksrad' end,p_day);
 end if;
end;
$$;

revoke all on function public.bootcamp_profile_settings(uuid),public.bootcamp_save_profile_settings(uuid,date,boolean,boolean,boolean,time),
 public.bootcamp_member_state(uuid,jsonb),public.bootcamp_claim_birthday_ticket(uuid,date,integer) from public,anon,authenticated;
grant execute on function public.bootcamp_profile_settings(uuid),public.bootcamp_save_profile_settings(uuid,date,boolean,boolean,boolean,time),
 public.bootcamp_member_state(uuid,jsonb),public.bootcamp_claim_birthday_ticket(uuid,date,integer) to service_role;

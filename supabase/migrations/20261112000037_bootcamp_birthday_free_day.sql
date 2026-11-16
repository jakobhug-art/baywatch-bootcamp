create table bootcamp_private.birthday_free_days (
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 gift_year integer not null,
 day date not null,
 wheel_unlocked boolean not null default false,
 primary key(user_id,gift_year)
);
alter table bootcamp_private.birthday_free_days enable row level security;

create function bootcamp_private.issue_birthday_free_day()
returns trigger language plpgsql set search_path='' as $$
begin
 insert into bootcamp_private.birthday_free_days(user_id,gift_year,day)
 values(new.user_id,new.gift_year,new.day) on conflict do nothing;
 if found then
  insert into bootcamp_private.rest_vouchers(user_id) values(new.user_id);
 end if;
 return new;
end;
$$;

create trigger issue_birthday_free_day
after insert on bootcamp_private.birthday_tickets
for each row when (new.turn=1) execute function bootcamp_private.issue_birthday_free_day();

with gifts as (
 insert into bootcamp_private.birthday_free_days(user_id,gift_year,day)
 select user_id,gift_year,day from bootcamp_private.birthday_tickets where day=bootcamp_private.today() and turn=1
 on conflict do nothing returning user_id
)
insert into bootcamp_private.rest_vouchers(user_id) select user_id from gifts;

create function bootcamp_private.birthday_wheel_unlocked(p_user uuid,p_day date)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from bootcamp_private.birthday_free_days where user_id=p_user and day=p_day and wheel_unlocked)
$$;

create or replace function public.bootcamp_spin(p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_coins integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_first_bonus boolean;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.current_deck();
 select bonus into v_first_bonus from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=1;
 if v_first_bonus is null and not exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day)
    and not bootcamp_private.birthday_wheel_unlocked(p_user,p_day) then
  raise sqlstate 'PT403' using message='Schließe zuerst dein Workout ab.';
 end if;
 if p_turn is null or p_turn not in (1,2)
    or (p_turn=1 and v_first_bonus is not null)
    or (p_turn=2 and v_first_bonus is distinct from true)
    or exists(select 1 from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=p_turn) then
  raise sqlstate 'PT409' using message='Heute ist kein weiterer Dreh verfügbar.';
 end if;
 insert into bootcamp_private.wheel_spins(user_id,day,turn,slot,title,description,initial,reward,bonus)
 values(p_user,p_day,p_turn,p_slot,p_card->>'title',p_card->>'description',(p_card->>'initial')::integer,
  (p_card->>'reward')::integer,p_turn=1 and coalesce((p_card->>'bonus')::boolean,false));
 if p_coins between 1 and 3 then
  insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,p_coins,'Glücksrad',p_day);
 end if;
 if p_card->'rest'='true'::jsonb then
  insert into bootcamp_private.rest_vouchers(user_id) values(p_user);
 end if;
end;
$$;

create or replace function public.bootcamp_member_state_with_tickets(p_user uuid,p_birthday_symbols jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb:=public.bootcamp_member_state(p_user,p_birthday_symbols);
 v_day date:=bootcamp_private.today();
begin
 if v_state->'user'='null'::jsonb then return v_state; end if;
 return v_state||jsonb_build_object(
  'birthdayWheelUnlocked',bootcamp_private.birthday_wheel_unlocked(p_user,v_day),
  'scratchTickets',(v_state->'scratchTickets')||coalesce((
   select jsonb_agg(jsonb_build_object('day',day,'turn',turn,'ticket',2,'values',symbols,'claimed',claimed) order by turn)
   from bootcamp_private.wheel_extra_tickets where user_id=p_user and day=v_day
  ),'[]'::jsonb)
 );
end;
$$;

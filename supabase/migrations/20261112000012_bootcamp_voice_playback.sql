alter table bootcamp_private.pranks add column voice_expires_at timestamptz;
-- Older recordings have a calendar date but no timestamp.
update bootcamp_private.pranks
set voice_expires_at=(day::timestamp at time zone 'Europe/Berlin')+interval '48 hours'
where kind='voice';

create function bootcamp_private.set_voice_expiry()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='voice' then
  new.voice_expires_at:=now()+interval '48 hours';
  new.expires:=(new.voice_expires_at at time zone 'Europe/Berlin')::date;
 end if;
 return new;
end;
$$;
create trigger set_voice_expiry before insert on bootcamp_private.pranks
for each row execute function bootcamp_private.set_voice_expiry();

create table bootcamp_private.exercise_completions(
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 day date not null,
 exercise text not null,
 primary key(user_id,day,exercise)
);
alter table bootcamp_private.exercise_completions enable row level security;
insert into bootcamp_private.exercise_completions
select user_id,day,exercise from bootcamp_private.quantities
where day=bootcamp_private.today() and reached;

create function public.bootcamp_save_quantity_with_voice(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.bootcamp_save_quantity(p_user,p_day,p_exercise,p_amount);
 insert into bootcamp_private.exercise_completions
 select user_id,day,exercise from bootcamp_private.quantities
 where user_id=p_user and day=p_day and exercise=p_exercise and reached
 on conflict do nothing;
 if not found then return jsonb_build_object('voiceIds','[]'::jsonb); end if;
 return jsonb_build_object('voiceIds',coalesce((
  select jsonb_agg(id order by id) from bootcamp_private.pranks
  where recipient=p_user and kind='voice' and voice_expires_at>now()
 ),'[]'::jsonb));
end;
$$;
revoke all on function public.bootcamp_save_quantity_with_voice(uuid,date,text,integer) from public,anon,authenticated;
grant execute on function public.bootcamp_save_quantity_with_voice(uuid,date,text,integer) to service_role;

create or replace function public.bootcamp_voice_path(p_user uuid,p_id bigint)
returns text language sql stable security definer set search_path='' as $$
 select audio_path from bootcamp_private.pranks
 where id=p_id and kind='voice' and p_user in (sender,recipient) and voice_expires_at>now()
$$;

create or replace function bootcamp_private.wallet(p_user uuid,p_day date)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'balance',bootcamp_private.balance(p_user),
  'vouchers',(select count(*) from bootcamp_private.rest_vouchers where user_id=p_user and used is null),
  'rest',exists(select 1 from bootcamp_private.rest_days where user_id=p_user and day=p_day),
  'prices',jsonb_build_object('voice',2,'symbol',5,'exercise',6,'return',4,'rest',12),
  'symbols',jsonb_build_array('💩','❤️','🍑','🍆','🖕'),
  'exercises',jsonb_build_array('3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze'),
  'friends',coalesce((select jsonb_agg(jsonb_build_object('id',id,'handle',handle) order by lower(handle))
    from bootcamp_private.profiles where id<>p_user),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(to_jsonb(h)-'id' order by h.id desc) from (
    select id,amount,label,day from bootcamp_private.coin_entries where user_id=p_user order by id desc limit 25
   ) h),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',p.id,'kind',p.kind,'detail',p.detail,'day',p.day,'expires',p.expires,'status',p.status,
    'sender_done',p.sender_done,'recipient_done',p.recipient_done,'sender',p.sender,'recipient',p.recipient,
    'fromName',s.handle,'toName',r.handle,
    'canReturn',not exists(select 1 from bootcamp_private.pranks child where child.source=p.id)
   ) order by p.id desc)
   from bootcamp_private.pranks p join bootcamp_private.profiles s on s.id=p.sender
   join bootcamp_private.profiles r on r.id=p.recipient
   where p_user in (p.sender,p.recipient) and p.expires>=p_day
     and (p.kind<>'voice' or p.voice_expires_at>now())),'[]'::jsonb)
 )
$$;

create table bootcamp_private.coin_requests (
 user_id uuid not null references bootcamp_private.profiles on delete cascade,
 request_id uuid not null,
 primary key(user_id,request_id)
);
alter table bootcamp_private.coin_requests enable row level security;

create function bootcamp_private.today()
returns date language sql stable set search_path='' as $$
 select (now() at time zone 'Europe/Berlin')::date
$$;

create function bootcamp_private.check_day(p_day date)
returns void language plpgsql stable set search_path='' as $$
begin
 if p_day is distinct from bootcamp_private.today() then
  raise sqlstate 'PT409' using message='Der Tag hat gewechselt. Lade die Seite neu.';
 end if;
end;
$$;

create function public.bootcamp_spin(p_user uuid,p_day date,p_turn integer,p_slot integer,p_card jsonb,p_coins integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_first_bonus boolean;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.current_deck();
 if not exists(select 1 from bootcamp_private.completed_days where user_id=p_user and day=p_day) then
  raise sqlstate 'PT403' using message='Erreiche zuerst alle Tagesziele.';
 end if;
 select bonus into v_first_bonus from bootcamp_private.wheel_spins where user_id=p_user and day=p_day and turn=1;
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

create function public.bootcamp_complete_spin(p_user uuid,p_day date,p_turn integer)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 update bootcamp_private.wheel_spins set completed=true
 where user_id=p_user and day=p_day and turn=p_turn and reward is not null and not completed;
 if not found then raise sqlstate 'PT409' using message='Für heute gibt es keine offene Rad-Aufgabe.'; end if;
end;
$$;

create function bootcamp_private.balance(p_user uuid)
returns bigint language sql stable set search_path='' as $$
 select coalesce(sum(amount),0) from bootcamp_private.coin_entries where user_id=p_user
$$;

create function bootcamp_private.wallet(p_user uuid,p_day date)
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
   where p_user in (p.sender,p.recipient) and p.expires>=p_day),'[]'::jsonb)
 )
$$;

create function public.bootcamp_buy(p_user uuid,p_day date,p_request uuid,p_kind text,p_target uuid,p_detail text,p_source bigint,p_audio_path text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare
 v_price integer := case p_kind when 'voice' then 2 when 'symbol' then 5 when 'exercise' then 6 when 'return' then 4 when 'rest' then 12 end;
 v_label text := case p_kind when 'voice' then 'Sprachnachricht' when 'symbol' then 'Symbol-Prank' when 'exercise' then 'Extraübung' when 'return' then 'Retourkutsche' else 'Freier Tag' end;
 v_expires date := p_day;
 v_voucher bigint;
 v_source bootcamp_private.pranks%rowtype;
begin
 perform bootcamp_private.check_day(p_day);
 if v_price is null or p_request is null then raise sqlstate 'PT400' using message='Wähle eine Aktion.'; end if;
 perform pg_advisory_xact_lock(72417001);
 insert into bootcamp_private.coin_requests values(p_user,p_request) on conflict do nothing;
 if not found then return false; end if;
 if p_kind='rest' then
  select id into v_voucher from bootcamp_private.rest_vouchers where user_id=p_user and used is null order by id limit 1;
 end if;
 if v_voucher is null and bootcamp_private.balance(p_user)<v_price then
  raise sqlstate 'PT409' using message='Du hast nicht genug Münzen.';
 end if;
 if p_kind='rest' then
  perform bootcamp_private.current_deck();
  insert into bootcamp_private.rest_days values(p_user,p_day) on conflict do nothing;
  if not found then raise sqlstate 'PT409' using message='Heute ist bereits ein freier Tag.'; end if;
  if v_voucher is not null then
   update bootcamp_private.rest_vouchers set used=p_day where id=v_voucher;
   return true;
  end if;
 else
  if p_kind='return' then
   select * into v_source from bootcamp_private.pranks where id=p_source and recipient=p_user and kind<>'return' and expires>=p_day;
   if not found or exists(select 1 from bootcamp_private.pranks where source=p_source) then
    raise sqlstate 'PT409' using message='Diese Retourkutsche ist nicht verfügbar.';
   end if;
   p_target := v_source.sender;
   if v_source.kind='exercise' then p_detail := v_source.detail; end if;
  else
   p_source := null;
  end if;
  if p_target is null or p_target=p_user or not exists(select 1 from bootcamp_private.profiles where id=p_target) then
   raise sqlstate 'PT400' using message='Wähle eine Person.';
  end if;
  if p_kind='symbol' then
   if p_detail is null or p_detail not in ('💩','❤️','🍑','🍆','🖕') then raise sqlstate 'PT400' using message='Wähle ein Symbol.'; end if;
   if exists(select 1 from bootcamp_private.pranks where recipient=p_target and kind='symbol' and expires>=p_day) then
    raise sqlstate 'PT409' using message='Diese Person hat bereits einen aktiven Symbol-Prank.';
   end if;
   v_expires := p_day+6;
  elsif p_kind in ('exercise','return') then
   if p_detail is null or p_detail not in ('3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze') then
    raise sqlstate 'PT400' using message='Wähle eine Extraübung.';
   end if;
   if exists(select 1 from bootcamp_private.pranks where recipient=p_target and day=p_day and kind in ('exercise','return')) then
    raise sqlstate 'PT409' using message='Diese Person hat heute bereits eine Extraübung erhalten.';
   end if;
  elsif p_kind='voice' then
   if p_audio_path is null or p_detail is null or p_detail not in ('audio/webm','audio/ogg','audio/mp4') then
    raise sqlstate 'PT400' using message='Die Aufnahme fehlt oder hat ein ungültiges Format.';
   end if;
   v_expires := p_day+6;
  end if;
  insert into bootcamp_private.pranks(sender,recipient,kind,detail,day,expires,source,audio_path)
  values(p_user,p_target,p_kind,p_detail,p_day,v_expires,p_source,p_audio_path);
 end if;
 insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,-v_price,v_label,p_day);
 return true;
end;
$$;

create function public.bootcamp_respond(p_user uuid,p_day date,p_id bigint,p_action text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 if p_action in ('accept','decline') then
  update bootcamp_private.pranks set status=case when p_action='accept' then 'accepted' else 'declined' end
  where id=p_id and recipient=p_user and expires>=p_day and kind in ('exercise','return') and status='pending';
 elsif p_action='done' then
  update bootcamp_private.pranks
  set recipient_done=recipient_done or recipient=p_user,sender_done=sender_done or sender=p_user
  where id=p_id and expires>=p_day and status='accepted'
    and ((kind in ('exercise','return') and recipient=p_user) or (kind='return' and sender=p_user));
 else
  raise sqlstate 'PT400' using message='Ungültige Aktion.';
 end if;
 if not found then raise sqlstate 'PT409' using message='Diese Aktion ist für die Challenge nicht verfügbar.'; end if;
end;
$$;

create function public.bootcamp_voice_path(p_user uuid,p_id bigint)
returns text language sql stable security definer set search_path='' as $$
 select audio_path from bootcamp_private.pranks
 where id=p_id and kind='voice' and p_user in (sender,recipient) and expires>=bootcamp_private.today()
$$;

alter function public.bootcamp_training_state(uuid) set schema bootcamp_private;
create function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb := bootcamp_private.bootcamp_training_state(p_user);
 v_day date := (v_state->'deck'->>'day')::date;
begin
 return v_state || jsonb_build_object(
  'spins',coalesce((select jsonb_agg(to_jsonb(s)-'user_id'-'day' order by s.turn)
   from bootcamp_private.wheel_spins s where s.user_id=p_user and s.day=v_day),'[]'::jsonb),
  'coins',case when v_state->'user'='null'::jsonb then null else bootcamp_private.wallet(p_user,v_day) end
 );
end;
$$;

revoke all on function public.bootcamp_training_state(uuid),public.bootcamp_spin(uuid,date,integer,integer,jsonb,integer),
 public.bootcamp_complete_spin(uuid,date,integer),public.bootcamp_buy(uuid,date,uuid,text,uuid,text,bigint,text),
 public.bootcamp_respond(uuid,date,bigint,text),public.bootcamp_voice_path(uuid,bigint) from public,anon,authenticated;
grant execute on function public.bootcamp_training_state(uuid),public.bootcamp_spin(uuid,date,integer,integer,jsonb,integer),
 public.bootcamp_complete_spin(uuid,date,integer),public.bootcamp_buy(uuid,date,uuid,text,uuid,text,bigint,text),
 public.bootcamp_respond(uuid,date,bigint,text),public.bootcamp_voice_path(uuid,bigint) to service_role;

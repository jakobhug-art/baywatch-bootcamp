alter table bootcamp_private.pranks drop constraint pranks_kind_check;
alter table bootcamp_private.pranks add constraint pranks_kind_check
 check (kind in ('voice','symbol','exercise','return','nickname'));

create function public.bootcamp_buy_nickname(p_user uuid,p_day date,p_request uuid,p_target uuid,p_detail text,p_duration text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
 v_detail text := btrim(p_detail);
 v_price integer;
 v_expires date;
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then
  raise sqlstate 'PT403' using message='Registrierung erforderlich.';
 end if;
 if p_request is null or p_duration is null or p_duration not in ('week','season') then
  raise sqlstate 'PT400' using message='Wähle die Laufzeit des Namenszusatzes.';
 end if;
 if v_detail is null or char_length(v_detail) not between 2 and 40 or v_detail ~ '[[:cntrl:]]' then
  raise sqlstate 'PT400' using message='Der Namenszusatz muss 2 bis 40 Zeichen lang sein.';
 end if;
 if p_target is null or p_target=p_user or not public.bootcamp_has_profile(p_target) then
  raise sqlstate 'PT400' using message='Wähle eine Person.';
 end if;
 v_price:=case p_duration when 'week' then 8 else 24 end;
 v_expires:=case p_duration when 'week' then p_day+6
  else (bootcamp_private.season_start(p_day)+interval '2 months')::date-1 end;
 perform pg_advisory_xact_lock(72417001);
 insert into bootcamp_private.coin_requests values(p_user,p_request) on conflict do nothing;
 if not found then return false; end if;
 if bootcamp_private.balance(p_user)<v_price then
  raise sqlstate 'PT409' using message='Du hast nicht genug Münzen.';
 end if;
 insert into bootcamp_private.pranks(sender,recipient,kind,detail,day,expires)
 values(p_user,p_target,'nickname',v_detail,p_day,v_expires);
 insert into bootcamp_private.coin_entries(user_id,amount,label,day)
 values(p_user,-v_price,case p_duration when 'week' then 'Namenszusatz · 7 Tage' else 'Namenszusatz · Season' end,p_day);
 return true;
end;
$$;
revoke all on function public.bootcamp_buy_nickname(uuid,date,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.bootcamp_buy_nickname(uuid,date,uuid,uuid,text,text) to service_role;

create or replace function bootcamp_private.wallet(p_user uuid,p_day date)
returns jsonb language sql stable set search_path='' as $$
 with active as (
  select p.* from bootcamp_private.pranks p
  where p.day<=p_day and p.expires>=p_day and (p.kind<>'voice' or p.voice_expires_at>now())
 ), cards as (
  select p.*,
   jsonb_build_object('id',p.id,'kind',p.kind,'detail',p.detail,'day',p.day,'expires',p.expires,'status',p.status,
    'sender_done',p.sender_done,'recipient_done',p.recipient_done,'sender',p.sender,'recipient',p.recipient,
    'fromName',s.handle,'toName',r.handle,
    'canReturn',p.recipient=p_user and p.kind<>'return'
     and not exists(select 1 from bootcamp_private.pranks child where child.source=p.id)
   ) as card
  from active p join bootcamp_private.profiles s on s.id=p.sender
  join bootcamp_private.profiles r on r.id=p.recipient
 )
 select jsonb_build_object(
  'balance',bootcamp_private.balance(p_user),
  'vouchers',(select count(*) from bootcamp_private.rest_vouchers where user_id=p_user and used is null),
  'rest',exists(select 1 from bootcamp_private.rest_days where user_id=p_user and day=p_day),
  'prices',jsonb_build_object('voice',2,'symbol',5,'exercise',6,'return',4,'rest',12,'nickname_week',8,'nickname_season',24),
  'symbols',jsonb_build_array('💩','❤️','🍑','🍆','🖕'),
  'exercises',jsonb_build_array('3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze'),
  'friends',coalesce((select jsonb_agg(jsonb_build_object('id',id,'handle',handle) order by lower(handle))
    from bootcamp_private.profiles where id<>p_user),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(to_jsonb(h)-'id' order by h.id desc) from (
    select id,amount,label,day from bootcamp_private.coin_entries where user_id=p_user order by id desc limit 25
   ) h),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(card order by id desc) from cards where p_user in (sender,recipient)),'[]'::jsonb),
  'groupPranks',coalesce((select jsonb_agg(card order by id desc) from cards
    where day>=p_day-(extract(isodow from p_day)::integer-1)
      and status<>'declined' and (not recipient_done or (kind='return' and not sender_done))),'[]'::jsonb),
  'nicknames',coalesce((select jsonb_object_agg(recipient,detail order by id) from active where kind='nickname'),'{}'::jsonb)
 );
$$;

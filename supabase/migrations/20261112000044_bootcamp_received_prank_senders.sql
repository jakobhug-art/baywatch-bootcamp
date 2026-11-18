create or replace function bootcamp_private.wallet(p_user uuid,p_day date)
returns jsonb language sql stable set search_path='' as $$
 with viewer as (select exists(select 1 from bootcamp_private.profiles where id=p_user and is_admin) as admin), active as (
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
  'items',coalesce((select jsonb_agg(card order by id desc) from cards cross join viewer
    where (viewer.admin and p_user in (sender,recipient))
       or (not viewer.admin and (
         (recipient=p_user and (kind in ('symbol','nickname','voice') or (kind in ('exercise','return') and status<>'declined' and not recipient_done)))
         or (sender=p_user and kind='return' and status='accepted' and not sender_done)
       ))),'[]'::jsonb),
  'groupPranks',coalesce((select jsonb_agg(card order by id desc) from cards cross join viewer
    where viewer.admin and day>=p_day-(extract(isodow from p_day)::integer-1)
      and status<>'declined' and (not recipient_done or (kind='return' and not sender_done))),'[]'::jsonb),
  'nicknames',coalesce((select jsonb_object_agg(recipient,detail order by id) from active where kind='nickname'),'{}'::jsonb)
 );
$$;

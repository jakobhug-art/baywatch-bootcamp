alter table bootcamp_private.pranks add column mandatory boolean not null default false;

create function bootcamp_private.require_prank_exercise()
returns trigger language plpgsql set search_path='' as $$
begin
 new.mandatory:=true;
 new.status:='accepted';
 new.expires:=new.day+1;
 return new;
end;
$$;

create trigger require_prank_exercise before insert on bootcamp_private.pranks
for each row when (new.kind in ('exercise','return'))
execute function bootcamp_private.require_prank_exercise();

create or replace function public.bootcamp_respond(p_user uuid,p_day date,p_id bigint,p_action text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 if p_action in ('accept','decline') then
  update bootcamp_private.pranks set status=case when p_action='accept' then 'accepted' else 'declined' end
  where id=p_id and recipient=p_user and expires>=p_day and kind in ('exercise','return') and status='pending' and not mandatory;
 elsif p_action='done' then
  update bootcamp_private.pranks
  set recipient_done=recipient_done or recipient=p_user,sender_done=sender_done or sender=p_user
  where id=p_id and day<=p_day and expires>=p_day and status='accepted'
    and ((kind in ('exercise','return') and recipient=p_user) or (kind='return' and sender=p_user));
 else
  raise sqlstate 'PT400' using message='Ungültige Aktion.';
 end if;
 if not found then raise sqlstate 'PT409' using message='Diese Aktion ist für die Challenge nicht verfügbar.'; end if;
end;
$$;



create or replace function bootcamp_private.wallet(p_user uuid,p_day date)
returns jsonb language sql stable set search_path='' as $$
 with viewer as (select exists(select 1 from bootcamp_private.profiles where id=p_user and is_admin) as admin), active as (
  select p.* from bootcamp_private.pranks p
  where p.day<=p_day and p.expires>=p_day and (p.kind<>'voice' or p.voice_expires_at>now())
 ), cards as (
  select p.*,
   jsonb_build_object('id',p.id,'kind',p.kind,'detail',p.detail,'day',p.day,'expires',p.expires,'status',p.status,
    'sender_done',p.sender_done,'recipient_done',p.recipient_done,'sender',p.sender,'recipient',p.recipient,
    'fromName',s.handle,'toName',r.handle,'mandatory',p.mandatory,
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
         (recipient=p_user and (kind in ('symbol','nickname','voice') or (kind in ('exercise','return') and status<>'declined' and (mandatory or not recipient_done))))
         or (sender=p_user and kind='return' and status='accepted' and (mandatory or not sender_done))
       ))),'[]'::jsonb),
  'groupPranks',coalesce((select jsonb_agg(card order by id desc) from cards cross join viewer
    where viewer.admin and day>=p_day-(extract(isodow from p_day)::integer-1)
      and status<>'declined' and (not recipient_done or (kind='return' and not sender_done))),'[]'::jsonb),
  'nicknames',coalesce((select jsonb_object_agg(recipient,detail order by id) from active where kind='nickname'),'{}'::jsonb)
 );
$$;


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
select p.id,dates.day::date,'daily_penalty',-policy.points_per_missing*(required.count-achieved.count::integer)
from bootcamp_private.profiles p
join auth.users account on account.id=p.id
cross join bootcamp_private.daily_penalty_policy policy
cross join lateral generate_series(greatest(policy.starts_on,(account.created_at at time zone 'Europe/Berlin')::date),
 bootcamp_private.today(), interval '1 day') dates(day)
cross join lateral (
 select data from bootcamp_private.challenge_periods where kind='daily' and period<=dates.day::date
 order by period desc limit 1
) snapshot
cross join lateral (select jsonb_array_length(bootcamp_private.scored_daily(p.id,dates.day::date,snapshot.data)) as count) required
cross join lateral (
 select count(*) from bootcamp_private.effective_quantities q where q.user_id=p.id and q.day=dates.day::date and q.reached
) achieved
where achieved.count<required.count
 and (dates.day::date<bootcamp_private.today()
   or exists(select 1 from bootcamp_private.workout_finishes f where f.user_id=p.id and f.day=dates.day::date))
union all select user_id,day,'workout_photo',photo_bonus from bootcamp_private.workout_finishes where photo_bonus<>0
union all select target,resolved_on,'food_vote:'||id,-30 from bootcamp_private.food_polls where verdict
union all
select p.recipient,p.expires+1,'prank_penalty:'||p.id,-60
from bootcamp_private.pranks p
where p.mandatory and p.kind in ('exercise','return') and not p.recipient_done and p.expires<bootcamp_private.today()
union all
select p.sender,p.expires+1,'prank_penalty:'||p.id,-60
from bootcamp_private.pranks p
where p.mandatory and p.kind='return' and not p.sender_done and p.expires<bootcamp_private.today();

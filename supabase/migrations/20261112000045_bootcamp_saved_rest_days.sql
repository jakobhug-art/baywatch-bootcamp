alter table bootcamp_private.rest_days add column base_only boolean not null default false;
update bootcamp_private.rest_days set base_only=true where day>=bootcamp_private.today();
alter table bootcamp_private.rest_days alter column base_only set default true;

create or replace function public.bootcamp_buy(p_user uuid,p_day date,p_request uuid,p_kind text,p_target uuid,p_detail text,p_source bigint,p_audio_path text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare
 v_price integer := case p_kind when 'voice' then 2 when 'symbol' then 5 when 'exercise' then 6 when 'return' then 4 when 'rest' then 12 end;
 v_label text := case p_kind when 'voice' then 'Sprachnachricht' when 'symbol' then 'Symbol-Prank' when 'exercise' then 'Extraübung' when 'return' then 'Retourkutsche' else 'Gutschein für einen freien Tag' end;
 v_expires date := p_day;
 v_source bootcamp_private.pranks%rowtype;
begin
 perform bootcamp_private.check_day(p_day);
 if v_price is null or p_request is null then raise sqlstate 'PT400' using message='Wähle eine Aktion.'; end if;
 perform pg_advisory_xact_lock(72417001);
 insert into bootcamp_private.coin_requests values(p_user,p_request) on conflict do nothing;
 if not found then return false; end if;
 if bootcamp_private.balance(p_user)<v_price then
  raise sqlstate 'PT409' using message='Du hast nicht genug Münzen.';
 end if;
 if p_kind='rest' then
  insert into bootcamp_private.rest_vouchers(user_id) values(p_user);
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
   v_expires := p_day+6;
  elsif p_kind in ('exercise','return') then
   if p_detail is null or p_detail not in ('3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze') then
    raise sqlstate 'PT400' using message='Wähle eine Extraübung.';
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


create or replace function public.bootcamp_redeem_rest_voucher(p_user uuid,p_day date,p_request uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_voucher bigint;
 v_default text;
begin
 perform bootcamp_private.check_day(p_day);
 if p_request is null or not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 perform pg_advisory_xact_lock(72417001);
 if exists(select 1 from bootcamp_private.coin_requests where user_id=p_user and request_id=p_request) then return; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.require_open_workout(p_user,p_day);
 if exists(select 1 from bootcamp_private.rest_days where user_id=p_user and day=p_day) then
  raise sqlstate 'PT409' using message='Heute ist bereits ein freier Tag aktiv.';
 end if;
 select id into v_voucher from bootcamp_private.rest_vouchers where user_id=p_user and used is null order by id limit 1;
 if not found then raise sqlstate 'PT409' using message='Du hast keinen freien Tag zum Einlösen.'; end if;
 v_default:=bootcamp_private.skip_default(p_day,bootcamp_private.current_deck()->'daily');
 if v_default is not null and not exists(select 1 from bootcamp_private.daily_skips where user_id=p_user and day=p_day) then
  perform public.bootcamp_choose_skip(p_user,p_day,v_default);
 end if;
 insert into bootcamp_private.coin_requests values(p_user,p_request);
 insert into bootcamp_private.rest_days(user_id,day) values(p_user,p_day);
 update bootcamp_private.rest_vouchers set used=p_day where id=v_voucher;
end;
$$;

create or replace view bootcamp_private.effective_quantities as
select q.* from bootcamp_private.quantities q
left join bootcamp_private.challenge_periods p on p.period=q.day and p.kind='daily'
where not exists (select 1 from bootcamp_private.rest_days r where r.user_id=q.user_id and r.day=q.day)
 and not exists (select 1 from bootcamp_private.training_replacements t
  where t.user_id=q.user_id and t.day=q.day and t.exercise=q.exercise)
 and (p.data is null or bootcamp_private.scored_daily(q.user_id,q.day,p.data) @> jsonb_build_array(jsonb_build_object('id',q.exercise)))
union all
select r.user_id,r.day,card->>'id',
 case when r.base_only then (card->>'target')::integer else greatest((card->>'target')::integer,coalesce(q.amount,0)) end,
 case when r.base_only then bootcamp_private.exercise_points(card,(card->>'target')::integer)
 else greatest(bootcamp_private.exercise_points(card,(card->>'target')::integer),coalesce(q.points,0)) end,true
from bootcamp_private.rest_days r
join bootcamp_private.challenge_periods p on p.period=r.day and p.kind='daily'
cross join lateral jsonb_array_elements(bootcamp_private.scored_daily(r.user_id,r.day,p.data)) card
left join bootcamp_private.quantities q on q.user_id=r.user_id and q.day=r.day and q.exercise=card->>'id'
where not exists (select 1 from bootcamp_private.training_replacements t
 where t.user_id=r.user_id and t.day=r.day and t.exercise=card->>'id')
union all
select t.user_id,t.day,t.exercise,(card->>'target')::integer,
 bootcamp_private.exercise_points(card,(card->>'target')::integer),true
from bootcamp_private.training_replacements t
join bootcamp_private.challenge_periods p on p.period=t.day and p.kind='daily'
cross join lateral jsonb_array_elements(p.data) card
where card->>'id'=t.exercise;


create or replace function public.bootcamp_save_quantity(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_deck jsonb := bootcamp_private.current_deck();
 v_card jsonb;
begin
 perform bootcamp_private.check_day(p_day);
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 perform bootcamp_private.require_open_workout(p_user,p_day);
 if exists(select 1 from bootcamp_private.rest_days where user_id=p_user and day=p_day) then
  raise sqlstate 'PT409' using message='Deine Tagesübungen sind für den freien Tag gesperrt.';
 end if;
 if exists(select 1 from bootcamp_private.training_replacements where user_id=p_user and day=p_day and exercise=p_exercise) then
  raise sqlstate 'PT409' using message='Diese Übung wurde heute durch Training ersetzt.';
 end if;
 select card into v_card from jsonb_array_elements(v_deck->'daily') card where card->>'id'=p_exercise;
 if v_card is null or p_amount is null or p_amount not between 0 and 10000 then
  raise sqlstate 'PT400' using message='Wähle eine Tagesübung und gib eine ganze Zahl zwischen 0 und 10.000 ein.';
 end if;
 insert into bootcamp_private.quantities(user_id,day,exercise,amount,points,reached)
 values(p_user,p_day,p_exercise,p_amount,bootcamp_private.exercise_points(v_card,p_amount),p_amount>=(v_card->>'target')::integer)
 on conflict(user_id,day,exercise) do update set amount=excluded.amount,points=excluded.points,reached=excluded.reached;
end;
$$;

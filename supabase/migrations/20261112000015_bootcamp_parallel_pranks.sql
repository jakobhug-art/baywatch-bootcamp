-- A recipient can have several active pranks. Each purchase keeps its own expiry and sender.
create or replace function public.bootcamp_buy(p_user uuid,p_day date,p_request uuid,p_kind text,p_target uuid,p_detail text,p_source bigint,p_audio_path text default null)
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
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
  perform bootcamp_private.require_open_workout(p_user,p_day);
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

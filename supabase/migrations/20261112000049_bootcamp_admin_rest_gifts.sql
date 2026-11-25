create or replace function public.bootcamp_manage_member(p_admin uuid,p_member uuid,p_request uuid,p_kind text,p_delta integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_result jsonb;
 v_balance bigint;
begin
 perform bootcamp_private.require_admin(p_admin);
 if p_request is null or p_kind is null or p_kind not in ('coins','reset-pranks','rest-voucher') then
  raise sqlstate 'PT400' using message='Ungültige Aktion.';
 end if;
 perform pg_advisory_xact_lock(72417001);
 select result into v_result from bootcamp_private.member_admin_actions
 where request_id=p_request and admin_id=p_admin and member_id=p_member and kind=p_kind;
 if found then return v_result; end if;
 if not exists(select 1 from bootcamp_private.profiles where id=p_member) then
  raise sqlstate 'PT404' using message='Konto nicht gefunden.';
 end if;
 if p_kind='coins' then
  if p_delta is null or p_delta=0 or p_delta not between -100000 and 100000
     or p_reason is null or char_length(trim(p_reason)) not between 1 and 120 then
   raise sqlstate 'PT400' using message='Gib einen Betrag und einen Grund ein.';
  end if;
  v_balance:=bootcamp_private.balance(p_member)+p_delta;
  if v_balance<0 then raise sqlstate 'PT409' using message='Das Konto hat nicht genug Münzen.'; end if;
  insert into bootcamp_private.coin_entries(user_id,amount,label,day)
  values(p_member,p_delta,'Admin: '||trim(p_reason),bootcamp_private.today());
  v_result:=jsonb_build_object('balance',v_balance);
 elsif p_kind='rest-voucher' then
  insert into bootcamp_private.rest_vouchers(user_id) values(p_member);
  select jsonb_build_object('vouchers',count(*)) into v_result
  from bootcamp_private.rest_vouchers where user_id=p_member and used is null;
 else
  with removed as (
   delete from bootcamp_private.pranks where p_member in (sender,recipient)
   returning audio_path
  )
  select jsonb_build_object('removed',count(*),'audioPaths',
   coalesce(jsonb_agg(audio_path) filter(where audio_path is not null),'[]'::jsonb))
  into v_result from removed;
 end if;
 insert into bootcamp_private.member_admin_actions(request_id,admin_id,member_id,kind,result)
 values(p_request,p_admin,p_member,p_kind,v_result);
 return v_result;
end;
$$;

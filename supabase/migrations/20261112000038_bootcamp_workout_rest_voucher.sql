create function public.bootcamp_redeem_rest_voucher(p_user uuid,p_day date,p_request uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 -- Use the same wallet lock as the shop, so a concurrent purchase cannot consume the voucher in between.
 perform pg_advisory_xact_lock(72417001);
 if exists(select 1 from bootcamp_private.coin_requests where user_id=p_user and request_id=p_request) then
  return;
 end if;
 if not exists(select 1 from bootcamp_private.rest_vouchers where user_id=p_user and used is null) then
  raise sqlstate 'PT409' using message='Du hast keinen freien Tag zum Einlösen.';
 end if;
 perform public.bootcamp_buy(p_user,p_day,p_request,'rest',null,null,null,null);
end;
$$;

revoke all on function public.bootcamp_redeem_rest_voucher(uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.bootcamp_redeem_rest_voucher(uuid,date,uuid) to service_role;

alter table bootcamp_private.wheel_spins add column spun_at timestamptz;
alter table bootcamp_private.wheel_spins alter column spun_at set default clock_timestamp();

create function public.bootcamp_wheel_activity(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return jsonb_build_object(
  'nibbelzwickCount',(select count(*) from bootcamp_private.wheel_spins where slot=9),
  'recent',coalesce((select jsonb_agg(jsonb_build_object('handle',handle,'day',day,'slot',slot,'title',title)
    order by day desc,spun_at desc nulls last,turn desc,user_id) from (
   select p.handle,s.day,s.slot,s.title,s.spun_at,s.turn,s.user_id
   from bootcamp_private.wheel_spins s join bootcamp_private.profiles p on p.id=s.user_id
   order by s.day desc,s.spun_at desc nulls last,s.turn desc,s.user_id limit 8
  ) latest),'[]'::jsonb)
 );
end;
$$;

revoke all on function public.bootcamp_wheel_activity(uuid) from public,anon,authenticated;
grant execute on function public.bootcamp_wheel_activity(uuid) to service_role;

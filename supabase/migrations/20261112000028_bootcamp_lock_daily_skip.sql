create or replace function public.bootcamp_choose_skip(p_user uuid,p_day date,p_exercise text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_cards jsonb;
 v_skip text;
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 select exercise into v_skip from bootcamp_private.daily_skips where user_id=p_user and day=p_day;
 if found then
  if v_skip=p_exercise then return; end if;
  raise sqlstate 'PT409' using message='Die gestrichene Übung steht für heute bereits fest.';
 end if;
 perform bootcamp_private.require_open_workout(p_user,p_day);
 v_cards:=bootcamp_private.current_deck()->'daily';
 if bootcamp_private.skip_default(p_day,v_cards) is null or not exists(
  select 1 from jsonb_array_elements(v_cards) card where card->>'id'=p_exercise
 ) then raise sqlstate 'PT400' using message='Wähle eine Tagesübung zum Streichen.'; end if;
 insert into bootcamp_private.daily_skips values(p_user,p_day,p_exercise);
end;
$$;

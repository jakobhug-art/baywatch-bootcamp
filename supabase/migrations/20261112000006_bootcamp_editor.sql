create function public.bootcamp_challenges(p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_user);
 return jsonb_build_object('entries',coalesce((
  select jsonb_agg(data||jsonb_build_object('kind',kind,'enabled',enabled) order by lower(data->>'name'))
  from bootcamp_private.challenge_catalog
 ),'[]'::jsonb));
end;
$$;

create function public.bootcamp_save_challenge(p_user uuid,p_input jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_id text := nullif(p_input->>'id','');
 v_kind text := p_input->>'kind';
 v_name text := trim(coalesce(p_input->>'name',''));
 v_hint text := trim(coalesce(p_input->>'hint',''));
 v_enabled boolean;
 v_old bootcamp_private.challenge_catalog%rowtype;
 v_data jsonb;
 v_target integer;
 v_step integer;
 v_points integer;
 v_unit text := p_input->>'unit';
 v_category text := p_input->>'category';
 v_difficulty text := p_input->>'difficulty';
 v_group text;
 v_groups text[] := array['Bewegung','Ernährung','Spaß & Abwechslung'];
begin
 perform bootcamp_private.require_admin(p_user);
 if v_kind is null or v_kind not in ('daily','weekly') or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
    or char_length(v_name) not between 1 and 80 or char_length(v_hint)>300 then
  raise sqlstate 'PT400' using message='Prüfe Titel und Beschreibung.';
 end if;
 perform pg_advisory_xact_lock(72417002);
 perform bootcamp_private.current_deck();
 v_enabled := (p_input->>'enabled')::boolean;
 if v_id is not null then
  select * into v_old from bootcamp_private.challenge_catalog where id=v_id and kind=v_kind;
  if not found then raise sqlstate 'PT404' using message='Aufgabe nicht gefunden.'; end if;
 else
  v_id := gen_random_uuid()::text;
 end if;
 v_data := jsonb_build_object('id',v_id,'name',v_name,'hint',v_hint);
 if v_kind='daily' then
  if coalesce(p_input->>'target','') !~ '^[0-9]{1,5}$' or coalesce(p_input->>'step','') !~ '^[0-9]{1,5}$' then
   raise sqlstate 'PT400' using message='Prüfe Zielmenge und Menge pro Punkt.';
  end if;
  v_target := (p_input->>'target')::integer;
  v_step := (p_input->>'step')::integer;
  if v_target not between 1 and 10000 or v_step not between 1 and v_target or v_unit is null or v_unit not in ('Wdh.','Sek.') then
   raise sqlstate 'PT400' using message='Prüfe Zielmenge, Einheit und Menge pro Punkt.';
  end if;
  if not v_enabled and not exists(select 1 from bootcamp_private.challenge_catalog where kind='daily' and enabled and id<>v_id) then
   raise sqlstate 'PT400' using message='Mindestens eine Tagesübung muss aktiv bleiben.';
  end if;
  v_data := v_data||jsonb_build_object('target',v_target,'step',v_step,'unit',v_unit,
   'icon',coalesce(v_old.data->>'icon','squat'),'color',coalesce(v_old.data->>'color','lime'));
 else
  if coalesce(p_input->>'points','') !~ '^[0-9]{1,4}$' then
   raise sqlstate 'PT400' using message='Prüfe die Punktzahl.';
  end if;
  v_points := (p_input->>'points')::integer;
  if v_points not between 1 and 1000 or v_hint='' or v_category is null or not (v_category=any(v_groups))
     or v_difficulty is null or v_difficulty not in ('Leicht','Mittel','Schwer') then
   raise sqlstate 'PT400' using message='Prüfe Kategorie, Schwierigkeit, Punkte und Beschreibung.';
  end if;
  foreach v_group in array v_groups loop
   if not (v_enabled and v_category=v_group) and not exists(
    select 1 from bootcamp_private.challenge_catalog where kind='weekly' and enabled and id<>v_id and data->>'category'=v_group
   ) then raise sqlstate 'PT400' using message='In jeder Wochenkategorie muss eine Aufgabe aktiv bleiben.'; end if;
  end loop;
  v_data := v_data||jsonb_build_object('points',v_points,'category',v_category,'difficulty',v_difficulty,
   'icon',case v_category when 'Bewegung' then '↗' when 'Ernährung' then '✿' else '✦' end,
   'color',case v_category when 'Bewegung' then 'pink' when 'Ernährung' then 'lime' else 'cyan' end);
 end if;
 insert into bootcamp_private.challenge_catalog(id,kind,enabled,data) values(v_id,v_kind,v_enabled,v_data)
 on conflict(id) do update set enabled=excluded.enabled,data=excluded.data;
end;
$$;

revoke all on function public.bootcamp_challenges(uuid),public.bootcamp_save_challenge(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bootcamp_challenges(uuid),public.bootcamp_save_challenge(uuid,jsonb) to service_role;

-- Service-only API. The edge function authenticates users before calling it.
create function bootcamp_private.current_deck(p_at timestamptz default now())
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_day date := (p_at at time zone 'Europe/Berlin')::date;
  v_week date := v_day - (extract(isodow from v_day)::integer - 1);
  v_daily jsonb;
  v_weekly jsonb;
  v_previous jsonb;
begin
  select data into v_daily from bootcamp_private.challenge_periods where period = v_day and kind = 'daily';
  if v_daily is null then
    insert into bootcamp_private.challenge_periods (period, kind, data)
    select v_day, 'daily', coalesce(jsonb_agg(data order by (case id when 'push' then 1 when 'plank' then 2 when 'pull' then 3 when 'situp' then 4 when 'squat' then 5 else 6 end), id), '[]'::jsonb)
    from bootcamp_private.challenge_catalog where kind = 'daily' and enabled
    on conflict do nothing;
    select data into v_daily from bootcamp_private.challenge_periods where period = v_day and kind = 'daily';
  end if;
  select data into v_weekly from bootcamp_private.challenge_periods where period = v_week and kind = 'weekly';
  if v_weekly is null then
    select data into v_previous from bootcamp_private.challenge_periods
    where kind = 'weekly' and period < v_week order by period desc limit 1;
    insert into bootcamp_private.challenge_periods (period, kind, data)
    select v_week, 'weekly', coalesce(jsonb_agg(
      jsonb_build_array(c.data->>'id', c.data->>'icon', c.data->>'name', c.data->>'hint',
        c.data->'points', c.data->>'color', groups.name, c.data->>'difficulty') order by groups.position
    ), '[]'::jsonb)
    from (values ('Bewegung',1), ('Ernährung',2), ('Spaß & Abwechslung',3)) groups(name,position)
    cross join lateral (
      select catalog.data from bootcamp_private.challenge_catalog catalog
      where catalog.kind = 'weekly' and catalog.enabled and catalog.data->>'category' = groups.name
      order by exists(select 1 from jsonb_array_elements(coalesce(v_previous,'[]'::jsonb)) old where old->>0 = catalog.id), random()
      limit 1
    ) c
    on conflict do nothing;
    select data into v_weekly from bootcamp_private.challenge_periods where period = v_week and kind = 'weekly';
  end if;
  return jsonb_build_object('day',v_day,'week',v_week,'month',to_char(v_day,'YYYY-MM'),
    'daily',v_daily,'weekly',v_weekly,'monthTarget',12,'monthBonus',100);
end;
$$;

create function public.bootcamp_training_state(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deck jsonb := bootcamp_private.current_deck();
  v_day date := (v_deck->>'day')::date;
  v_week date := (v_deck->>'week')::date;
begin
  return jsonb_build_object(
    'deck',v_deck,
    'user',(select jsonb_build_object('id',id,'handle',handle,'admin',is_admin) from bootcamp_private.profiles where id=p_user),
    'quantities',coalesce((select jsonb_agg(jsonb_build_object('exercise',exercise,'amount',amount,'points',points))
      from bootcamp_private.quantities where user_id=p_user and day=v_day),'[]'::jsonb),
    'marks',coalesce((select jsonb_agg(jsonb_build_object('exercise',exercise))
      from bootcamp_private.marks where user_id=p_user and week=v_week),'[]'::jsonb)
  );
end;
$$;

create function public.bootcamp_save_quantity(p_user uuid,p_day date,p_exercise text,p_amount integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_deck jsonb := bootcamp_private.current_deck();
  v_card jsonb;
  v_target integer;
  v_step integer;
  v_base integer;
  v_bonus integer;
begin
  if p_day is distinct from (v_deck->>'day')::date then
    raise sqlstate 'PT409' using message = 'Der Tag hat gewechselt. Lade die Seite neu.';
  end if;
  select card into v_card from jsonb_array_elements(v_deck->'daily') card where card->>'id'=p_exercise;
  if v_card is null or p_amount is null or p_amount not between 0 and 10000 then
    raise sqlstate 'PT400' using message = 'Wähle eine Tagesübung und gib eine ganze Zahl zwischen 0 und 10.000 ein.';
  end if;
  v_target := (v_card->>'target')::integer;
  v_step := (v_card->>'step')::integer;
  v_base := least(p_amount,v_target)/v_step;
  v_bonus := least(least(greatest(p_amount-v_target,0),v_target)/(4*v_step),v_base/4);
  insert into bootcamp_private.quantities (user_id,day,exercise,amount,points,reached)
  values (p_user,p_day,p_exercise,p_amount,v_base+v_bonus,p_amount>=v_target)
  on conflict (user_id,day,exercise) do update set amount=excluded.amount,points=excluded.points,reached=excluded.reached;
end;
$$;

create function public.bootcamp_save_mark(p_user uuid,p_week date,p_exercise text,p_done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_deck jsonb := bootcamp_private.current_deck();
  v_card jsonb;
begin
  if p_week is distinct from (v_deck->>'week')::date then
    raise sqlstate 'PT409' using message = 'Die Woche hat gewechselt. Lade die Seite neu.';
  end if;
  select card into v_card from jsonb_array_elements(v_deck->'weekly') card where card->>0=p_exercise;
  if v_card is null or p_done is null then
    raise sqlstate 'PT400' using message = 'Ungültige Wochenaufgabe.';
  end if;
  if p_done then
    insert into bootcamp_private.marks (user_id,week,exercise,earned_on,points)
    values (p_user,p_week,p_exercise,(v_deck->>'day')::date,(v_card->>4)::integer)
    on conflict (user_id,week,exercise) do nothing;
  else
    delete from bootcamp_private.marks where user_id=p_user and week=p_week and exercise=p_exercise;
  end if;
end;
$$;

revoke all on function public.bootcamp_training_state(uuid) from public, anon, authenticated;
revoke all on function public.bootcamp_save_quantity(uuid,date,text,integer) from public, anon, authenticated;
revoke all on function public.bootcamp_save_mark(uuid,date,text,boolean) from public, anon, authenticated;
grant execute on function public.bootcamp_training_state(uuid) to service_role;
grant execute on function public.bootcamp_save_quantity(uuid,date,text,integer) to service_role;
grant execute on function public.bootcamp_save_mark(uuid,date,text,boolean) to service_role;

create function public.bootcamp_create_profile(p_user uuid,p_handle text)
returns void language sql security definer set search_path = '' as $$
  insert into bootcamp_private.profiles (id,handle) values (p_user,p_handle);
$$;
revoke all on function public.bootcamp_create_profile(uuid,text) from public, anon, authenticated;
grant execute on function public.bootcamp_create_profile(uuid,text) to service_role;

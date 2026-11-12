create function bootcamp_private.require_admin(p_user uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists(select 1 from bootcamp_private.profiles where id=p_user and is_admin) then
    raise sqlstate 'PT403' using message='Für diese Aktion brauchst du Adminrechte.';
  end if;
end;
$$;

create function public.bootcamp_reports(p_user uuid)
returns jsonb language sql security definer set search_path = '' as $$
 select jsonb_build_object(
  'admin',viewer.is_admin,
  'reports',coalesce((select jsonb_agg(
    jsonb_build_object('id',r.id,'kind',r.kind,'title',r.title,'message',r.message,'status',r.status,
      'created',floor(extract(epoch from r.created)*1000),'updated',floor(extract(epoch from r.updated)*1000))
      || case when viewer.is_admin then jsonb_build_object('handle',author.handle) else '{}'::jsonb end
    order by r.id desc)
    from bootcamp_private.reports r join bootcamp_private.profiles author on author.id=r.user_id
    where viewer.is_admin or r.user_id=viewer.id),'[]'::jsonb)
 )
 from bootcamp_private.profiles viewer where viewer.id=p_user;
$$;

create function public.bootcamp_create_report(p_user uuid,p_kind text,p_title text,p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if p_kind is null or p_kind not in ('bug','feedback') or p_title is null or p_message is null
    or char_length(p_title) not between 3 and 90 or char_length(p_message) not between 5 and 1500 then
  raise sqlstate 'PT400' using message='Prüfe Kategorie, Titel und Beschreibung.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if (select count(*) from bootcamp_private.reports where user_id=p_user and created>now()-interval '1 hour')>=10 then
  raise sqlstate 'PT429' using message='Du kannst bis zu zehn Meldungen pro Stunde senden.';
 end if;
 insert into bootcamp_private.reports(user_id,kind,title,message) values(p_user,p_kind,p_title,p_message);
end;
$$;

create function public.bootcamp_report_status(p_user uuid,p_id bigint,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
 perform bootcamp_private.require_admin(p_user);
 if p_status is null or p_status not in ('open','acknowledged','resolved') then
  raise sqlstate 'PT400' using message='Ungültiger Status.';
 end if;
 update bootcamp_private.reports set status=p_status,updated=now() where id=p_id;
 if not found then raise sqlstate 'PT404' using message='Meldung nicht gefunden.'; end if;
end;
$$;

create function public.bootcamp_reset_points(p_user uuid,p_day date)
returns void language plpgsql security definer set search_path = '' as $$
declare
 v_id bigint;
 v_day date := (now() at time zone 'Europe/Berlin')::date;
begin
 perform bootcamp_private.require_admin(p_user);
 if p_day is distinct from v_day then
  raise sqlstate 'PT409' using message='Der Tag hat gewechselt. Lade die Seite neu.';
 end if;
 insert into bootcamp_private.point_resets(day,admin) values(v_day,p_user) returning id into v_id;
 insert into bootcamp_private.point_reset_entries(reset_id,user_id,event,points)
 select v_id,user_id,event,points from bootcamp_private.point_events where day=v_day;
end;
$$;

revoke all on function public.bootcamp_reports(uuid) from public, anon, authenticated;
revoke all on function public.bootcamp_create_report(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.bootcamp_report_status(uuid,bigint,text) from public, anon, authenticated;
revoke all on function public.bootcamp_reset_points(uuid,date) from public, anon, authenticated;
grant execute on function public.bootcamp_reports(uuid) to service_role;
grant execute on function public.bootcamp_create_report(uuid,text,text,text) to service_role;
grant execute on function public.bootcamp_report_status(uuid,bigint,text) to service_role;
grant execute on function public.bootcamp_reset_points(uuid,date) to service_role;

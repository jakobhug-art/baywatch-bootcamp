create function bootcamp_private.season_start(p_day date)
returns date language sql immutable strict set search_path='' as $$
 select make_date(extract(year from p_day)::integer,((extract(month from p_day)::integer-1)/2)*2+1,1)
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('bootcamp-workouts','bootcamp-workouts',false,160000,array['image/jpeg']);

create table bootcamp_private.workout_photos(
 id bigint generated always as identity primary key,
 user_id uuid not null,
 day date not null,
 object_path text not null unique,
 unique(user_id,day),
 foreign key(user_id,day) references bootcamp_private.workout_finishes on delete cascade
);
alter table bootcamp_private.workout_photos enable row level security;
create index workout_photos_day on bootcamp_private.workout_photos(day);

create function public.bootcamp_finish_with_photo(p_user uuid,p_day date,p_path text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.check_day(p_day);
 if not public.bootcamp_has_profile(p_user) then
  raise sqlstate 'PT403' using message='Registrierung erforderlich.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
 if exists(select 1 from bootcamp_private.workout_finishes where user_id=p_user and day=p_day) then
  return false;
 end if;
 perform public.bootcamp_finish_workout(p_user,p_day);
 insert into bootcamp_private.workout_photos(user_id,day,object_path) values(p_user,p_day,p_path);
 return true;
end;
$$;

create table bootcamp_private.weekly_prank_purchases(
 sender uuid not null references bootcamp_private.profiles on delete cascade,
 recipient uuid not null references bootcamp_private.profiles on delete cascade,
 kind text not null,
 week date not null,
 primary key(sender,recipient,kind,week)
);
alter table bootcamp_private.weekly_prank_purchases enable row level security;
insert into bootcamp_private.weekly_prank_purchases
select distinct sender,recipient,kind,day-(extract(isodow from day)::integer-1)
from bootcamp_private.pranks where day>=bootcamp_private.today()-6;

create function bootcamp_private.limit_weekly_pranks()
returns trigger language plpgsql set search_path='' as $$
begin
 insert into bootcamp_private.weekly_prank_purchases
 values(new.sender,new.recipient,new.kind,new.day-(extract(isodow from new.day)::integer-1))
 on conflict do nothing;
 if not found then
  raise sqlstate 'PT409' using message='Du hast dieser Person diese Woche schon einen Prank dieser Art geschickt.';
 end if;
 return new;
end;
$$;
create trigger limit_weekly_pranks before insert on bootcamp_private.pranks
for each row execute function bootcamp_private.limit_weekly_pranks();

create or replace function public.bootcamp_voice_archive(p_user uuid,p_before bigint)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(entry) order by entry.id desc),'[]'::jsonb)
 from (
  select p.id,p.day,s.handle as "fromName",r.handle as "toName"
  from bootcamp_private.pranks p
  join bootcamp_private.profiles s on s.id=p.sender
  join bootcamp_private.profiles r on r.id=p.recipient
  where p.kind='voice' and p.audio_path is not null and public.bootcamp_has_profile(p_user)
   and p.day>=bootcamp_private.season_start(bootcamp_private.today())
   and (p_before is null or p.id<p_before)
  order by p.id desc limit 31
 ) entry;
$$;

create or replace function public.bootcamp_archived_voice_path(p_user uuid,p_id bigint)
returns text language sql stable security definer set search_path='' as $$
 select audio_path from bootcamp_private.pranks
 where id=p_id and kind='voice' and day>=bootcamp_private.season_start(bootcamp_private.today())
  and public.bootcamp_has_profile(p_user);
$$;
drop function public.bootcamp_share_voice(uuid,bigint,boolean);
alter table bootcamp_private.pranks drop column voice_shared;

create function public.bootcamp_workout_gallery(p_user uuid,p_id bigint default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select case when p_id is null then (
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'day',p.day,'handle',m.handle) order by p.id),'[]'::jsonb)
  from bootcamp_private.workout_photos p join bootcamp_private.profiles m on m.id=p.user_id
  where public.bootcamp_has_profile(p_user) and p.day>=bootcamp_private.season_start(bootcamp_private.today())
 ) else (
  select to_jsonb(object_path) from bootcamp_private.workout_photos
  where id=p_id and public.bootcamp_has_profile(p_user) and day>=bootcamp_private.season_start(bootcamp_private.today())
 ) end
$$;

create view bootcamp_private.season_media as
select p.day,'bootcamp-workouts'::text as bucket,p.object_path as path,
 'Fotos/'||p.day||'_'||m.handle||'_'||p.id||'.jpg' as filename
from bootcamp_private.workout_photos p join bootcamp_private.profiles m on m.id=p.user_id
union all
select p.day,'bootcamp-voice',p.audio_path,
 'Sprachnachrichten/'||p.day||'_'||s.handle||'_an_'||r.handle||'_'||p.id||
 case p.detail when 'audio/mp4' then '.m4a' when 'audio/ogg' then '.ogg' else '.webm' end
from bootcamp_private.pranks p join bootcamp_private.profiles s on s.id=p.sender
join bootcamp_private.profiles r on r.id=p.recipient
where p.kind='voice' and p.audio_path is not null;

create function public.bootcamp_media_seasons(p_admin uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_admin);
 return (
  select coalesce(jsonb_agg(to_jsonb(season) order by season.start desc),'[]'::jsonb)
  from (
   select bootcamp_private.season_start(m.day) as start,count(*) as files,
    coalesce(sum((o.metadata->>'size')::bigint),0) as bytes
   from bootcamp_private.season_media m left join storage.objects o on o.bucket_id=m.bucket and o.name=m.path
   group by bootcamp_private.season_start(m.day)
  ) season
 );
end;
$$;

create function public.bootcamp_media_manifest(p_admin uuid,p_start date,p_limit integer default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_admin);
 if p_start is null or p_start<>bootcamp_private.season_start(p_start)
  or p_start>=bootcamp_private.season_start(bootcamp_private.today()) then
  raise sqlstate 'PT400' using message='Wähle eine abgeschlossene Season.';
 end if;
 return (
  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.bucket,entry.path),'[]'::jsonb)
  from (
   select bucket,path,filename from bootcamp_private.season_media
   where day>=p_start and day<(p_start+interval '2 months')::date
   order by bucket,path limit p_limit
  ) entry
 );
end;
$$;

create function public.bootcamp_forget_media(p_admin uuid,p_bucket text,p_paths text[])
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_admin);
 if p_bucket='bootcamp-workouts' then
  delete from bootcamp_private.workout_photos where object_path=any(p_paths)
   and day<bootcamp_private.season_start(bootcamp_private.today());
 elsif p_bucket='bootcamp-voice' then
  update bootcamp_private.pranks set audio_path=null where audio_path=any(p_paths)
   and day<bootcamp_private.season_start(bootcamp_private.today());
 end if;
end;
$$;

revoke all on function public.bootcamp_finish_with_photo(uuid,date,text),public.bootcamp_workout_gallery(uuid,bigint),
 public.bootcamp_media_seasons(uuid),public.bootcamp_media_manifest(uuid,date,integer),public.bootcamp_forget_media(uuid,text,text[])
 from public,anon,authenticated;
grant execute on function public.bootcamp_finish_with_photo(uuid,date,text),public.bootcamp_workout_gallery(uuid,bigint),
 public.bootcamp_media_seasons(uuid),public.bootcamp_media_manifest(uuid,date,integer),public.bootcamp_forget_media(uuid,text,text[])
 to service_role;

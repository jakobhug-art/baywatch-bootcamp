alter table bootcamp_private.pranks add column voice_shared boolean not null default false;

create function public.bootcamp_voice_archive(p_user uuid,p_before bigint)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',entry.id,'day',entry.day,'fromName',entry.sender_name,'toName',entry.recipient_name,
  'own',entry.sender=p_user,'shared',entry.voice_shared
 ) order by entry.id desc),'[]'::jsonb)
 from (
  select p.id,p.day,p.sender,p.voice_shared,s.handle as sender_name,r.handle as recipient_name
  from bootcamp_private.pranks p
  join bootcamp_private.profiles s on s.id=p.sender
  join bootcamp_private.profiles r on r.id=p.recipient
  where p.kind='voice' and p.audio_path is not null and (p.voice_shared or p_user in (p.sender,p.recipient))
   and (p_before is null or p.id<p_before) and public.bootcamp_has_profile(p_user)
  order by p.id desc limit 31
 ) entry;
$$;

create function public.bootcamp_archived_voice_path(p_user uuid,p_id bigint)
returns text language sql stable security definer set search_path='' as $$
 select audio_path from bootcamp_private.pranks
 where id=p_id and kind='voice' and (voice_shared or p_user in (sender,recipient)) and public.bootcamp_has_profile(p_user);
$$;

create function public.bootcamp_share_voice(p_user uuid,p_id bigint,p_shared boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 update bootcamp_private.pranks set voice_shared=p_shared
 where id=p_id and kind='voice' and audio_path is not null and sender=p_user;
 if not found then
  raise sqlstate 'PT404' using message='Aufnahme nicht gefunden.';
 end if;
end;
$$;

revoke all on function public.bootcamp_voice_archive(uuid,bigint),public.bootcamp_archived_voice_path(uuid,bigint),
 public.bootcamp_share_voice(uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function public.bootcamp_voice_archive(uuid,bigint),public.bootcamp_archived_voice_path(uuid,bigint),
 public.bootcamp_share_voice(uuid,bigint,boolean) to service_role;

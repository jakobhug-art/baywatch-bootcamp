insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('bootcamp-portraits','bootcamp-portraits',false,1000000,array['image/jpeg']);

create function public.bootcamp_has_profile(p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from bootcamp_private.profiles where id=p_user);
$$;
revoke all on function public.bootcamp_has_profile(uuid) from public,anon,authenticated;
grant execute on function public.bootcamp_has_profile(uuid) to service_role;

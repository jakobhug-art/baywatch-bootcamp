create table bootcamp_private.chat_messages (
 id bigint generated always as identity primary key,
 author uuid not null references bootcamp_private.profiles on delete cascade,
 request_id uuid not null,
 body text not null check(char_length(body) between 1 and 1000 and body ~ '[^[:space:]]'),
 created_at timestamptz not null default now(),
 pinned boolean not null default false,
 unique(author,request_id)
);
alter table bootcamp_private.chat_messages enable row level security;
create unique index chat_single_pin on bootcamp_private.chat_messages(pinned) where pinned;

create view bootcamp_private.chat_display as
select m.id,m.id::text as "messageId",p.handle as author,m.body,m.created_at as "createdAt",m.pinned
from bootcamp_private.chat_messages m join bootcamp_private.profiles p on p.id=m.author;

create function public.bootcamp_chat(p_user uuid,p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return jsonb_build_object(
  'messages',coalesce((select jsonb_agg(to_jsonb(m)-'id' order by id) from (
   select * from bootcamp_private.chat_display where p_before is null or id<p_before order by id desc limit 40
  ) m),'[]'::jsonb),
  'pinned',(select to_jsonb(m)-'id' from bootcamp_private.chat_display m where pinned)
 );
end;
$$;

create function public.bootcamp_chat_send(p_user uuid,p_request uuid,p_body text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 if p_request is null or p_body is null or char_length(p_body) not between 1 and 1000 or p_body !~ '[^[:space:]]' then
  raise sqlstate 'PT400' using message='Schreib eine Nachricht mit bis zu 1.000 Zeichen.';
 end if;
 insert into bootcamp_private.chat_messages(author,request_id,body) values(p_user,p_request,p_body)
 on conflict(author,request_id) do nothing;
end;
$$;

create function public.bootcamp_chat_pin(p_user uuid,p_id bigint,p_pin boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform bootcamp_private.require_admin(p_user);
 if p_pin is null then raise sqlstate 'PT400' using message='Ungültige Aktion.'; end if;
 perform pg_advisory_xact_lock(72417030);
 if not exists(select 1 from bootcamp_private.chat_messages where id=p_id) then
  raise sqlstate 'PT404' using message='Nachricht nicht gefunden.';
 end if;
 if p_pin then update bootcamp_private.chat_messages set pinned=false where pinned and id<>p_id; end if;
 update bootcamp_private.chat_messages set pinned=p_pin where id=p_id;
end;
$$;

revoke all on function public.bootcamp_chat(uuid,bigint),public.bootcamp_chat_send(uuid,uuid,text),
 public.bootcamp_chat_pin(uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function public.bootcamp_chat(uuid,bigint),public.bootcamp_chat_send(uuid,uuid,text),
 public.bootcamp_chat_pin(uuid,bigint,boolean) to service_role;

create or replace function bootcamp_private.enqueue_chat_push()
returns trigger language plpgsql set search_path='' as $$
declare
 v_preview text:=trim(regexp_replace(new.body,'[[:space:]]+',' ','g'));
begin
 if char_length(v_preview)>160 then
  v_preview:=left(v_preview,159)||'…';
 end if;
 insert into bootcamp_private.push_jobs(device_id,event_key,day,kind,body)
 select d.id,'chat:'||new.id::text,bootcamp_private.today(),'chat',p.handle||': '||v_preview
 from bootcamp_private.push_devices d
 join bootcamp_private.profiles p on p.id=new.author
 left join bootcamp_private.profile_settings s on s.user_id=d.user_id
 where d.user_id<>new.author and coalesce(s.chat_notifications,true)
 on conflict do nothing;
 return new;
end;
$$;

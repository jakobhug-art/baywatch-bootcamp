create or replace function public.bootcamp_food_polls(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.bootcamp_has_profile(p_user) then raise sqlstate 'PT403' using message='Registrierung erforderlich.'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(entry)),'[]'::jsonb) from (
  select p.id,t.handle as "targetName",r.handle as "reporterName",p.created_at as "createdAt",
   p.verdict,p.created_at<=now()-interval '7 days' as expired,
   p.photo is not null and p.created_at>now()-interval '7 days' as "hasPhoto",
   count(*) filter(where b.guilty) as yes,count(*) filter(where not b.guilty) as no,
   count(b.voter)/2+1 as majority,
   coalesce(bool_or(b.voter=p_user and b.guilty is null),false) as "canVote",
   bool_or(b.guilty) filter(where b.voter=p_user) as "myVote",
   coalesce(jsonb_agg(jsonb_build_object('name',v.handle,'guilty',b.guilty) order by lower(v.handle),v.id)
    filter(where b.voter is not null),'[]'::jsonb) as ballots
  from bootcamp_private.food_polls p
  join bootcamp_private.profiles t on t.id=p.target join bootcamp_private.profiles r on r.id=p.reporter
  left join bootcamp_private.food_ballots b on b.poll=p.id
  left join bootcamp_private.profiles v on v.id=b.voter
  group by p.id,t.handle,r.handle
  order by (p.verdict is null and p.created_at>now()-interval '7 days') desc,p.created_at desc limit 25
 ) entry);
end;
$$;

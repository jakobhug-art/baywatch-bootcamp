create or replace function bootcamp_private.season_start(p_day date)
returns date language sql immutable strict set search_path='' as $$
 select case when p_day < date '2026-11-16' then
  make_date(extract(year from p_day)::integer,((extract(month from p_day)::integer-1)/2)*2+1,1)
 else
  (date '2026-11-16' + interval '2 months' * (
   ((extract(year from p_day)::integer-2026)*12+extract(month from p_day)::integer-11
    -case when extract(day from p_day)<16 then 1 else 0 end)/2
  ))::date
 end
$$;

create table bootcamp_private.wheel_extra_tickets (
 user_id uuid not null,
 day date not null,
 turn integer not null,
 symbols smallint[] not null check(cardinality(symbols)=3 and array_position(symbols,null) is null
  and symbols <@ array[1,2,3,15]::smallint[]),
 claimed boolean not null default false,
 primary key(user_id,day,turn),
 foreign key(user_id,day,turn) references bootcamp_private.wheel_spins(user_id,day,turn) on delete cascade
);
alter table bootcamp_private.wheel_extra_tickets enable row level security;

create function bootcamp_private.draw_wheel_ticket()
returns smallint[] language plpgsql volatile set search_path='' as $$
declare
 v_roll integer:=floor(random()*100);
 v_prize smallint:=case when v_roll<50 then 0 when v_roll<74 then 1 when v_roll<89 then 2 when v_roll<99 then 3 else 15 end;
 v_symbols smallint[]:=array[1,2,3,15];
 v_first smallint;
 v_second smallint;
begin
 if v_prize>0 then return array[v_prize,v_prize,v_prize]; end if;
 v_first:=v_symbols[1+floor(random()*cardinality(v_symbols))::integer];
 v_second:=v_symbols[1+floor(random()*cardinality(v_symbols))::integer];
 if v_first=v_second then v_symbols:=array_remove(v_symbols,v_first); end if;
 return array[v_first,v_second,v_symbols[1+floor(random()*cardinality(v_symbols))::integer]];
end;
$$;

create function bootcamp_private.issue_wheel_extra_ticket()
returns trigger language plpgsql set search_path='' as $$
begin
 insert into bootcamp_private.wheel_extra_tickets(user_id,day,turn,symbols)
 values(new.user_id,new.day,new.turn,bootcamp_private.draw_wheel_ticket());
 return new;
end;
$$;

create trigger issue_wheel_extra_ticket
after update of scratch_values on bootcamp_private.wheel_spins
for each row when (old.scratch_values is null and new.scratch_values is not null)
execute function bootcamp_private.issue_wheel_extra_ticket();

insert into bootcamp_private.wheel_extra_tickets(user_id,day,turn,symbols)
select user_id,day,turn,bootcamp_private.draw_wheel_ticket()
from bootcamp_private.wheel_spins where day=bootcamp_private.today() and scratch_values is not null
on conflict do nothing;

create function public.bootcamp_member_state_with_tickets(p_user uuid,p_birthday_symbols jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_state jsonb:=public.bootcamp_member_state(p_user,p_birthday_symbols);
begin
 if v_state->'user'='null'::jsonb then return v_state; end if;
 return v_state||jsonb_build_object('scratchTickets',(v_state->'scratchTickets')||coalesce((
  select jsonb_agg(jsonb_build_object('day',day,'turn',turn,'ticket',2,'values',symbols,'claimed',claimed) order by turn)
  from bootcamp_private.wheel_extra_tickets where user_id=p_user and day=bootcamp_private.today()
 ),'[]'::jsonb));
end;
$$;

create function public.bootcamp_claim_wheel_ticket(p_user uuid,p_day date,p_turn integer,p_ticket integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_ticket bootcamp_private.wheel_extra_tickets%rowtype;
 v_prize integer:=0;
begin
 perform bootcamp_private.check_day(p_day);
 if p_ticket=1 then return public.bootcamp_claim_scratch(p_user,p_day,p_turn); end if;
 if p_ticket is distinct from 2 then raise sqlstate 'PT400' using message='Ungültiges Los.'; end if;
 select * into v_ticket from bootcamp_private.wheel_extra_tickets
 where user_id=p_user and day=p_day and turn=p_turn for update;
 if not found then raise sqlstate 'PT404' using message='Rubbellos nicht gefunden.'; end if;
 if v_ticket.symbols[1]=v_ticket.symbols[2] and v_ticket.symbols[2]=v_ticket.symbols[3] then v_prize:=v_ticket.symbols[1]; end if;
 if not v_ticket.claimed then
  update bootcamp_private.wheel_extra_tickets set claimed=true where user_id=p_user and day=p_day and turn=p_turn;
  if v_prize>0 then
   insert into bootcamp_private.coin_entries(user_id,amount,label,day) values(p_user,v_prize,'Rubbellos',p_day);
  end if;
 end if;
 return jsonb_build_object('prize',v_prize);
end;
$$;

revoke all on function public.bootcamp_member_state_with_tickets(uuid,jsonb),public.bootcamp_claim_wheel_ticket(uuid,date,integer,integer)
 from public,anon,authenticated;
grant execute on function public.bootcamp_member_state_with_tickets(uuid,jsonb),public.bootcamp_claim_wheel_ticket(uuid,date,integer,integer)
 to service_role;

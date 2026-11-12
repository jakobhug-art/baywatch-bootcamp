-- Application data is private. Auth supplies the identity; server functions own writes.
create schema if not exists bootcamp_private;
revoke all on schema bootcamp_private from public, anon, authenticated;

create table bootcamp_private.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null check (char_length(handle) between 2 and 24),
  is_admin boolean not null default false
);
create unique index profiles_handle_unique on bootcamp_private.profiles (lower(handle));

create table bootcamp_private.challenge_catalog (
  id text primary key,
  kind text not null check (kind in ('daily', 'weekly')),
  enabled boolean not null default true,
  data jsonb not null check (jsonb_typeof(data) = 'object')
);

create table bootcamp_private.challenge_periods (
  period date not null,
  kind text not null check (kind in ('daily', 'weekly')),
  data jsonb not null check (jsonb_typeof(data) = 'array'),
  primary key (period, kind)
);

create table bootcamp_private.quantities (
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  day date not null,
  exercise text not null,
  amount integer not null check (amount between 0 and 10000),
  points integer not null check (points >= 0),
  reached boolean not null,
  primary key (user_id, day, exercise)
);

create table bootcamp_private.marks (
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  week date not null,
  exercise text not null,
  earned_on date not null,
  points integer not null check (points >= 0),
  primary key (user_id, week, exercise)
);

create table bootcamp_private.wheel_spins (
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  day date not null,
  turn integer not null check (turn in (1, 2)),
  slot integer not null check (slot >= 0),
  title text not null,
  description text not null,
  initial integer not null,
  reward integer,
  bonus boolean not null default false,
  completed boolean not null default false,
  primary key (user_id, day, turn)
);

create table bootcamp_private.coin_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  amount integer not null check (amount <> 0),
  label text not null,
  day date not null
);
create index coin_entries_user on bootcamp_private.coin_entries (user_id, id desc);

create table bootcamp_private.rest_days (
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  day date not null,
  primary key (user_id, day)
);

create table bootcamp_private.rest_vouchers (
  id bigint generated always as identity primary key,
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  used date
);

create table bootcamp_private.pranks (
  id bigint generated always as identity primary key,
  sender uuid not null references bootcamp_private.profiles on delete cascade,
  recipient uuid not null references bootcamp_private.profiles on delete cascade,
  kind text not null check (kind in ('voice', 'symbol', 'exercise', 'return')),
  detail text not null,
  day date not null,
  expires date not null,
  source bigint unique references bootcamp_private.pranks on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  sender_done boolean not null default false,
  recipient_done boolean not null default false,
  audio_path text,
  check (sender <> recipient),
  check (expires >= day)
);
create index pranks_inbox on bootcamp_private.pranks (recipient, expires desc);
create index pranks_outbox on bootcamp_private.pranks (sender, expires desc);

create table bootcamp_private.reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  kind text not null check (kind in ('bug', 'feedback')),
  title text not null check (char_length(title) between 3 and 90),
  message text not null check (char_length(message) between 5 and 1500),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);
create index reports_by_user on bootcamp_private.reports (user_id, id desc);

create table bootcamp_private.point_resets (
  id bigint generated always as identity primary key,
  day date not null,
  admin uuid references bootcamp_private.profiles on delete set null
);

create table bootcamp_private.point_reset_entries (
  reset_id bigint not null references bootcamp_private.point_resets on delete cascade,
  user_id uuid not null references bootcamp_private.profiles on delete cascade,
  event text not null,
  points integer not null,
  primary key (reset_id, user_id, event)
);

alter table bootcamp_private.profiles enable row level security;
alter table bootcamp_private.challenge_catalog enable row level security;
alter table bootcamp_private.challenge_periods enable row level security;
alter table bootcamp_private.quantities enable row level security;
alter table bootcamp_private.marks enable row level security;
alter table bootcamp_private.wheel_spins enable row level security;
alter table bootcamp_private.coin_entries enable row level security;
alter table bootcamp_private.rest_days enable row level security;
alter table bootcamp_private.rest_vouchers enable row level security;
alter table bootcamp_private.pranks enable row level security;
alter table bootcamp_private.reports enable row level security;
alter table bootcamp_private.point_resets enable row level security;
alter table bootcamp_private.point_reset_entries enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bootcamp-voice', 'bootcamp-voice', false, 600000, array['audio/webm','audio/ogg','audio/mp4']);

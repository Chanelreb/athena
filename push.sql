-- Athena's nudges: the part that is awake when nobody has the app open.
--
-- Run this once, in the Supabase SQL Editor, after filling in the two values
-- marked BEFORE YOU RUN THIS just below. It is safe to run again: every
-- statement checks first, and re-running only updates the two settings.
--
-- How it fits together, in one paragraph. Athena in the browser knows what your
-- week looks like, so it is Athena that works out which nudges are due over the
-- next seven days and writes them, already worded, into push_queue. This file
-- adds a job that wakes once a minute, takes whatever has come due, and hands
-- it to the app's /api/push endpoint, which does the encrypting and sending.
-- Nothing on this side knows what a block or a task is, which is the point:
-- none of Athena's thinking about your week is duplicated here, where it would
-- quietly drift out of step with the app.

-- ---------------------------------------------------------------------------
-- BEFORE YOU RUN THIS: put your own two values in the line below.
--   url    your Athena address with /api/push on the end
--   secret the same random string you put in Vercel as PUSH_CRON_SECRET
-- ---------------------------------------------------------------------------
create table if not exists public.push_config (
  id     integer primary key default 1,
  url    text not null,
  secret text not null,
  constraint push_config_single check (id = 1)
);
-- Nobody signed in should ever read this table. No policies are created for it
-- at all, and with row level security on, that means no access through the API.
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

insert into public.push_config (id, url, secret)
values (1, 'https://athena-eight-alpha.vercel.app/api/push', 'PASTE_YOUR_SECRET_HERE')
on conflict (id) do update set url = excluded.url, secret = excluded.secret;

-- ---------------------------------------------------------------------------
-- One row per device, not per person. A phone that is reinstalled or whose
-- subscription is renewed replaces its own row instead of leaving a dead one
-- behind, which is what keying on the endpoint would have done.
-- ---------------------------------------------------------------------------
create table if not exists public.push_subs (
  user_id  uuid not null references auth.users (id) on delete cascade,
  device   text not null,
  endpoint text not null,
  p256dh   text not null,
  auth     text not null,
  seen_at  timestamptz not null default now(),
  primary key (user_id, device)
);
alter table public.push_subs enable row level security;

drop policy if exists "read own subs"   on public.push_subs;
drop policy if exists "write own subs"  on public.push_subs;
drop policy if exists "update own subs" on public.push_subs;
drop policy if exists "delete own subs" on public.push_subs;

create policy "read own subs"   on public.push_subs for select using (auth.uid() = user_id);
create policy "write own subs"  on public.push_subs for insert with check (auth.uid() = user_id);
create policy "update own subs" on public.push_subs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own subs" on public.push_subs for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.push_subs to authenticated;

-- ---------------------------------------------------------------------------
-- The queue. Each row is a finished notification with a time to send it, put
-- there by the browser. Athena rewrites its own future rows whenever the plan
-- or the settings change, so this never holds a nudge for something that has
-- since moved.
-- ---------------------------------------------------------------------------
create table if not exists public.push_queue (
  id      bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  fire_at timestamptz not null,
  kind    text not null default 'nudge',
  title   text not null,
  body    text not null default '',
  tag     text not null default 'athena',
  url     text not null default './',
  -- Louder, and stays on screen: the must-not-miss deadlines.
  urgent  boolean not null default false,
  sent_at timestamptz
);
create index if not exists push_queue_due on public.push_queue (fire_at) where sent_at is null;
create index if not exists push_queue_mine on public.push_queue (user_id, fire_at);
alter table public.push_queue enable row level security;

drop policy if exists "read own queue"   on public.push_queue;
drop policy if exists "write own queue"  on public.push_queue;
drop policy if exists "delete own queue" on public.push_queue;

create policy "read own queue"  on public.push_queue for select using (auth.uid() = user_id);
create policy "write own queue" on public.push_queue for insert with check (auth.uid() = user_id);
create policy "delete own queue" on public.push_queue for delete using (auth.uid() = user_id);
-- Deliberately no update policy: the browser writes rows and deletes rows, and
-- only the job below is allowed to mark one as sent.
grant select, insert, delete on public.push_queue to authenticated;
grant usage, select on sequence public.push_queue_id_seq to authenticated;

-- ---------------------------------------------------------------------------
-- The once-a-minute run. security definer so it can see every account's queue,
-- which is exactly the thing row level security stops everyone else doing.
-- ---------------------------------------------------------------------------
-- pg_cron and pg_net are switched on from the Supabase dashboard, under
-- Database then Extensions, not from here. Creating them in SQL puts them in
-- the wrong schema on a Supabase project, and the failure looks like this file
-- being broken rather than a checkbox being unticked.

create or replace function public.athena_push_tick()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cfg     public.push_config%rowtype;
  payload jsonb;
  n       integer := 0;
begin
  select * into cfg from public.push_config where id = 1;
  if not found or cfg.secret is null or cfg.secret = 'PASTE_YOUR_SECRET_HERE' then
    return 0;
  end if;

  -- Anything more than a quarter of an hour late is retired unsent. A reminder
  -- that a block starts in five minutes is worthless three hours afterwards,
  -- and without this a spell of downtime would end in a pile of them arriving
  -- at once.
  update public.push_queue
     set sent_at = now()
   where sent_at is null
     and fire_at <= now() - interval '15 minutes';

  with due as (
    select q.id, s.endpoint, s.p256dh, s.auth, q.title, q.body, q.tag, q.url, q.urgent
      from public.push_queue q
      join public.push_subs  s on s.user_id = q.user_id
     where q.sent_at is null
       and q.fire_at <= now()
     limit 200
  ),
  marked as (
    update public.push_queue
       set sent_at = now()
     where id in (select id from due)
    returning 1
  )
  select jsonb_agg(to_jsonb(d) - 'id') into payload from due d;

  if payload is null then return 0; end if;
  n := jsonb_array_length(payload);

  -- Fire and forget. pg_net answers later and nothing here waits for it, so a
  -- failed send loses that one nudge rather than retrying it into a day-old
  -- reminder. For something that is only useful on time, that is the right way
  -- round.
  perform net.http_post(
    url     := cfg.url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-athena-cron', cfg.secret),
    body    := jsonb_build_object('items', payload)
  );
  return n;
end
$fn$;

revoke all on function public.athena_push_tick() from public, anon, authenticated;

-- Re-scheduling the same name replaces the old entry, so this file stays safe
-- to run twice.
select cron.unschedule('athena-push') where exists (select 1 from cron.job where jobname = 'athena-push');
select cron.schedule('athena-push', '* * * * *', $cron$select public.athena_push_tick()$cron$);

-- Nightly tidy: sent nudges are worth nothing after a few days, and a device
-- that has not checked in for two months is not coming back.
select cron.unschedule('athena-push-tidy') where exists (select 1 from cron.job where jobname = 'athena-push-tidy');
select cron.schedule('athena-push-tidy', '17 3 * * *', $cron$
  delete from public.push_queue where fire_at < now() - interval '3 days';
  delete from public.push_subs  where seen_at < now() - interval '60 days';
$cron$);

notify pgrst, 'reload schema';

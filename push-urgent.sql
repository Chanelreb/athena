-- Athena: one more column, for the nudges that are allowed to be louder.
--
-- Run this once in the Supabase SQL Editor, after push.sql. Safe to run again.
--
-- Must-not-miss deadlines are chased through the day rather than mentioned
-- once, and they need to arrive differently: a longer buzz, and staying on the
-- screen until they are dealt with instead of sliding away. The service worker
-- and the send endpoint already know what to do with the flag. This is the last
-- piece, which is the queue being able to carry it.
--
-- Until this has run, Athena notices the column is missing and sends those
-- nudges without the flag rather than failing, so nothing is broken in the
-- meantime. They simply arrive as ordinary nudges.

alter table public.push_queue
  add column if not exists urgent boolean not null default false;

-- The send job has to pass the flag along, so its query is replaced here. This
-- is the same function as in push.sql with one column added to the select, and
-- it still reads its url and secret from push_config, so there is nothing to
-- fill in.
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

  perform net.http_post(
    url     := cfg.url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-athena-cron', cfg.secret),
    body    := jsonb_build_object('items', payload)
  );
  return n;
end
$fn$;

revoke all on function public.athena_push_tick() from public, anon, authenticated;

notify pgrst, 'reload schema';

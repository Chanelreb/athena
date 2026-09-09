-- Athena database schema.
--
-- Run this once per Supabase project, in the SQL Editor. It is safe to run
-- again: every statement checks first, and it never touches existing rows.
--
-- This file exists because it went missing once. The table was created by
-- pasting SQL into a browser, nothing recorded it, and when it turned out not
-- to be there the only copy was in a chat log. Anything the app cannot run
-- without belongs in the repository.

-- One row per person. Their whole planner is a single JSON blob, which is why
-- there is exactly one table: user_id is the primary key, so the upsert the app
-- performs on every save has something to conflict against.
create table if not exists public.dashboards (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row level security is the whole privacy model. Without it, the publishable
-- key that ships in the browser would let anyone read everyone's planner.
alter table public.dashboards enable row level security;

drop policy if exists "read own dashboard"   on public.dashboards;
drop policy if exists "insert own dashboard" on public.dashboards;
drop policy if exists "update own dashboard" on public.dashboards;

create policy "read own dashboard"
  on public.dashboards for select
  using (auth.uid() = user_id);

create policy "insert own dashboard"
  on public.dashboards for insert
  with check (auth.uid() = user_id);

create policy "update own dashboard"
  on public.dashboards for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Deliberately no delete policy: nothing in the app deletes an account's row,
-- so nothing should be able to.

-- PostgREST caches the schema. A freshly created table stays invisible to the
-- app until this fires, which is exactly the "could not find the table
-- public.dashboards in the schema cache" error.
notify pgrst, 'reload schema';

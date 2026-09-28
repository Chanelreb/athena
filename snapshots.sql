-- Athena: a week of daily snapshots, so "put it back to how it was" exists.
--
-- Run this once in the Supabase SQL Editor. Safe to run again.
--
-- Why this is its own table rather than another column on dashboards: that row
-- is read and rewritten in full on every single save. Putting a week of copies
-- of your planner inside it would mean every tick of a checkbox carrying
-- several megabytes to the server and back. Snapshots are written once a day
-- and read almost never, which is the opposite shape, so they live apart.

create table if not exists public.snapshots (
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- One per day. The primary key does the work: the day's first save upserts
  -- onto the same row rather than piling up a copy per visit.
  taken_on   date not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, taken_on)
);

alter table public.snapshots enable row level security;

drop policy if exists "read own snapshots"   on public.snapshots;
drop policy if exists "write own snapshots"  on public.snapshots;
drop policy if exists "update own snapshots" on public.snapshots;
drop policy if exists "delete own snapshots" on public.snapshots;

create policy "read own snapshots"   on public.snapshots for select using (auth.uid() = user_id);
create policy "write own snapshots"  on public.snapshots for insert with check (auth.uid() = user_id);
create policy "update own snapshots" on public.snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own snapshots" on public.snapshots for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.snapshots to authenticated;

-- Athena keeps the last week itself, deleting anything older each time it
-- writes one. This index is what makes that delete and the list on the
-- Settings screen cheap.
create index if not exists snapshots_mine on public.snapshots (user_id, taken_on desc);

notify pgrst, 'reload schema';

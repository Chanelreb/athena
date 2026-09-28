-- Athena: connected Microsoft calendars.
--
-- Run this once in the Supabase SQL Editor. Safe to run again.
--
-- One row per connected account, so work and personal can both be attached and
-- either can be removed on its own. Microsoft's own account id is what keeps
-- reconnecting the same calendar from quietly making a second copy.
--
-- On where the tokens live, since it is the part worth thinking about. They sit
-- here rather than in the browser because a browser-held Microsoft token has to
-- be renewed constantly, and Safari's cookie rules break the silent renewal, so
-- you end up bounced to a Microsoft sign-in at random. A refresh token held
-- server side lasts months and renews itself as it is used.
--
-- They are still reachable by your own session, exactly like every other row in
-- Athena, because the alternative is giving the server a master key that can
-- read everybody's, and that is a worse trade. So they are stored encrypted:
-- the row you could fetch holds ciphertext, and the key that opens it lives in
-- Vercel with the rest of the server secrets. That is what stops a Microsoft
-- token ever reaching a browser, rather than the grants, which cannot tell your
-- browser and your server apart when both arrive holding your session.

create table if not exists public.ms_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- Microsoft's id for the account, so reconnecting updates rather than doubles.
  ms_id         text not null,
  -- The address, so you can tell work from personal at a glance.
  label         text not null default '',
  refresh_token text not null,
  access_token  text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, ms_id)
);

alter table public.ms_accounts enable row level security;

drop policy if exists "read own ms accounts"   on public.ms_accounts;
drop policy if exists "write own ms accounts"  on public.ms_accounts;
drop policy if exists "update own ms accounts" on public.ms_accounts;
drop policy if exists "delete own ms accounts" on public.ms_accounts;

create policy "read own ms accounts"   on public.ms_accounts for select using (auth.uid() = user_id);
create policy "write own ms accounts"  on public.ms_accounts for insert with check (auth.uid() = user_id);
create policy "update own ms accounts" on public.ms_accounts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own ms accounts" on public.ms_accounts for delete using (auth.uid() = user_id);

-- On the grants, and what they do not do.
--
-- Supabase hands every new table in this schema to anon and authenticated by
-- default, and a whole table grant outranks a narrower column one, so listing
-- safe columns here achieves nothing on its own. Revoking first is what makes
-- it bite. anon loses the table outright, since nobody signed out has business
-- with it.
--
-- authenticated keeps full select, and that is deliberate rather than an
-- oversight: the server reads this table as you, using your session, so any
-- grant narrow enough to hide the tokens from the browser would hide them from
-- the server too. The tokens are protected by being stored encrypted instead.
-- What is in these columns is ciphertext, and the key lives only in Vercel.
revoke all on public.ms_accounts from anon;
grant select, insert, update, delete on public.ms_accounts to authenticated;

create index if not exists ms_accounts_mine on public.ms_accounts (user_id);

notify pgrst, 'reload schema';

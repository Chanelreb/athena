# Mesh Dashboard — handoff

A single-file personal operating dashboard. No build step, no dependencies, no framework. Open `mesh-dashboard.html` in a browser and it runs.

---

## What it does

Four tabs:

- **Day** — a vertical time rail for today. The current block is highlighted with a draining progress bar. Gaps between blocks are labelled as open time. A capture box ("park a thought") sits under it.
- **Week** — seven day-rows as coloured strips on mobile, or a full seven-column calendar grid on wider screens. Blocks in the grid can be dragged to move day/time and resized from the bottom edge.
- **Habits** — daily tick-offs plus a four-week completion grid per habit with run counters. Custom habits can be added.
- **Goals** — goals with a target date, broken into daily / weekly / monthly steps. Steps flow automatically into the tick-offs, the calendar and the month lists.

Everything is categorised Work (blue), Personal (lilac) or Health (sage). Category totals are shown per day and per week.

---

## Storage contract

One key, one JSON blob:

```
mesh:dashboard:v1
```

All reads and writes go through a single `store` object at the top of the script. It uses `window.storage` inside a Claude artifact and falls back to `localStorage` everywhere else. **This is the only thing to replace when moving to a database.**

### State shape

```js
{
  dayKey:   '2026-09-04',        // rollover markers
  weekKey:  '2026-08-31',        // Monday of the current week
  monthKey: '2026-09',

  daily:   { vitamins: true, water: 3, <stepId>: true },   // cleared at midnight
  weekly:  { article: true, <stepId>: true },              // cleared Monday
  monthly: { newsletter: true, <stepId>: true },           // cleared on the 1st

  hist: { '2026-09-03': { vitamins: true, water: 4 } },     // archived daily, ~200 days
  moves: { '4:3': { d: 3, s: '10:00', e: '12:00' } },       // drag overrides, keyed by block uid
  goals: [ { id, title, by, cat, steps: [ { id, label, freq, day, time } ] } ],
  habits:[ { id, label, cat, max } ],
  projects: [ false, ... ],       // the one-off task queue, by index
  parked: [ { t: 'text' } ],
  hairoil: 0, patchLast: null, clayLast: null
}
```

### Rollover

On every load and render, `roll()` compares the stored day/week/month keys to now. When the day changes it archives `daily` into `hist` before clearing. This is the only place history is written — **do not remove it or the habit grids stop accumulating.**

---

## Where things are defined

| What | Where | Notes |
|---|---|---|
| Weekly schedule | `SCHEDULE` object, keyed 0–6 | Currently hardcoded |
| Catch-up Thursday | `THU_CATCHUP` + `isFriendWeek()` | Fortnightly, anchored to `FRIEND_ANCHOR = '2026-08-31'` |
| Weekly checklist | `WEEK` array | |
| Monthly checklist | `MONTHLY` array | |
| One-off task queue | `PROJECTS` array | 14 items, ordered by dependency |
| Built-in habits | `DAILY` array | |
| Daily lines | `LINES` array | 31, rotates on day-of-year |
| Line drawings | `MOTIFS` array + `MOON` | Inline SVG, rotates daily |
| Categories | `CATS` object | Colours live here |

`daySchedule(dayIdx, ref)` returns the base blocks for a weekday. `resolvedWeek(ref)` applies drag overrides and injects weekly goal steps, then returns all seven days. Every view reads from `resolvedWeek` — that's the single source of truth for what appears where.

---

## Known constraints

- **The schedule is code, not data.** Blocks can be dragged, but not created, renamed or deleted from the UI. Editing the week means editing `SCHEDULE`.
- **Drag only works in the expanded grid**, not the mobile strips.
- **`localStorage` is per-browser.** Phone and laptop will hold separate copies with no sync. This is the main reason to add a backend.
- Block `uid`s are positional (`'4:3'` = Thursday, index 3). Reordering `SCHEDULE` will mismatch existing drag overrides.

---

## Suggested migration path

### Phase 1 — get it running and hosted
Put the file in a git repo. Deploy as a static site (Netlify, Vercel, Cloudflare Pages). Still `localStorage`, still single-device, but installable to a phone home screen and easy to iterate on.

### Phase 2 — schedule becomes data
Move `SCHEDULE` out of code and into the stored state, then add UI to create, rename and delete blocks. This is the biggest usability win and it needs no backend. Do this before Phase 3 so the database schema is designed against the real shape.

### Phase 3 — real database
Swap the `store` object for API calls. Supabase is the shortest path: hosted Postgres, auth, and a JS client that works from a static site.

Suggested schema:

```sql
blocks        (id, day_of_week, start_time, end_time, title, note,
               category, item_key, active)
block_moves   (block_id, day_of_week, start_time, end_time)
goals         (id, title, target_date, category)
goal_steps    (id, goal_id, label, freq, day_of_week, time_of_day)
habits        (id, label, category, times_per_day, archived_at)
tasks         (id, label, position, done_at)          -- the one-off queue
parked        (id, body, created_at, cleared_at)

completions   (id, item_key, period_type, period_key, value)
              -- period_type: 'day' | 'week' | 'month'
              -- period_key:  '2026-09-04' | '2026-08-31' | '2026-09'
              -- unique (item_key, period_type, period_key)
```

`completions` is the important one. It collapses `daily`, `weekly`, `monthly` and `hist` into a single table and gives full history for everything, not just habits — so streaks, weekly consistency and goal progress over time all come from one query.

---

## A good first prompt for Claude Code

> This is a single-file HTML dashboard using localStorage under the key `mesh:dashboard:v1`. Read HANDOFF.md first. Don't restructure it yet — start by setting up a git repo, splitting the CSS and JS into separate files, and confirming it still runs identically. Then we'll move the hardcoded `SCHEDULE` object into stored state so blocks can be edited from the UI.

Asking for the split and the repo first gives you a safe checkpoint to roll back to before anything behavioural changes.

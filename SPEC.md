# Athena — build spec

A calm, personal life planner for you and a handful of friends & family. Grew out
of the single-file "Mesh Dashboard"; being rebuilt as a small multi-user web app.

> **Status:** awaiting approval to start building. Nothing in this doc is built yet.

---

## 1. What Athena is

A personal operating dashboard: your days and weeks laid out on purpose, plus
habits, goals and a place to park stray thoughts. Each person has their own
private account; their data syncs across phone and laptop.

Not a team tool, not public SaaS — a shared, hosted app that a few invited people
each use for their own life.

---

## 2. Decisions locked in (from our discovery)

| Area | Decision |
|---|---|
| **Audience** | Friends & family — a few invited people, each with private data |
| **Name** | **Athena** |
| **Login** | Supabase **magic link** (type email → click link → in; no passwords) |
| **Backend** | **Supabase** — a *new, dedicated* project (not the Mesh Finance one) |
| **Hosting** | **Vercel** — a *new* project pointed at this repo |
| **Data model** | One **JSON blob per user** (not relational tables — simpler, right-sized) |
| **Calendar** | **Real dates with recurrence** — routines repeat by a rule; one-offs land on any date |
| **Categories** | **User-customisable** — rename, recolour, add, remove |
| **Editing** | Works on **mobile** (tap-to-edit), not just the desktop drag-grid |
| **First-run** | **Guided setup** — a few questions generate a tailored starter week |
| **Modules kept** | Habits · Goals · Parked thoughts · Daily quote line (generic quote set) |
| **Personal routines** | Removed as built-ins — everyone builds their own |

---

## 3. Honest scope note

The current app is, at heart, a **repeating-weekly-rhythm** engine. Moving to a
**date-based calendar with recurrence** replaces that engine rather than extending
it. Combined with custom categories, mobile editing and guided onboarding, this is
**"build a small personal planner," not "migrate the old file."**

That's fine and doable — but it's why we're speccing carefully first, and why the
build is phased so the app stays usable at every step.

---

## 4. Architecture

- **Front end:** plain HTML/CSS/JS, no framework (keep the no-build simplicity).
  Split into `index.html` / `styles.css` / `app.js` (already done).
- **State:** a single `store` object is the only thing that reads/writes data.
  - Phase A: `store` → `localStorage` (as today)
  - Phase B: `store` → Supabase (one row per user: `user_id → JSON blob`)
- **Auth:** Supabase magic link. The logged-in user's id decides which blob loads.
- **Isolation:** Supabase Row-Level Security so each person can only read/write
  their own row. The public "anon" key is safe to ship in the static site.

### Data shape (the JSON blob per user)

Illustrative — exact fields finalised in Phase A:

```js
{
  schemaVersion: 2,
  profile:    { name, timezone, onboarded },
  categories: [ { id, label, color } ],                 // user-defined
  events: [ {
    id, title, note, categoryId,
    allDay, start, end,                                 // time-of-day, or all-day
    date,                                               // for a one-off, the single date
    recurrence: { freq, interval, weekdays, monthDay,   // e.g. every 2nd Thursday
                  anchor, until } | null,               // null = one-off
    overrides: { '2026-05-14': { start, end } },        // per-date tweaks to a series
    skips: [ '2026-05-21' ]                             // per-date cancellations
  } ],
  habits: [ { id, label, categoryId, target } ],        // target>1 = countable (water ×4)
  goals:  [ { id, title, targetDate, categoryId,
              steps: [ { id, label, freq } ] } ],
  parked: [ { id, text, createdAt } ],
  completions: {                                        // one map, full history
    '2026-05-12': { habit_water: 3, habit_vitamins: true, ev_reading: true }
  }
}
```

`completions` keyed by date is the important bit — it gives full history for
habits, goals and events from one place (streaks, weekly consistency, progress).

---

## 5. Build phases

### Phase A — Front end: the planner itself *(no backend, no accounts)*
The biggest chunk. App stays fully working on `localStorage` throughout.

- **A0.** Rename Mesh Dashboard → **Athena** (title, storage key `athena:v2`, folder/repo).
- **A1.** New data model: events with recurrence + a real date engine (given a date
  range, compute which events fall on which day).
- **A2.** Calendar views rebuilt on the new engine — Day (today's rail) and Week.
- **A3.** Create / rename / delete events, with recurrence options
  (once · daily · weekdays · weekly on chosen days · fortnightly · monthly).
- **A4.** Mobile tap-to-edit (edit form), alongside desktop drag.
- **A5.** User-customisable categories (add / rename / recolour / remove).
- **A6.** De-personalise: strip your hardcoded routines; generic quote set; a name
  the app stores instead of "Chanel".
- **A7.** Habits, Goals, Parked thoughts re-wired onto the new completion model.

*Delivers:* a full personal planner that works for anyone, still single-device.

### Phase B — Accounts & sync
- **B1.** New Supabase project + magic-link login + Row-Level Security.
- **B2.** Swap `store` from `localStorage` to Supabase (per-user blob).
- **B3.** Guided first-run setup → generates each new user's starter week.
- **B4.** Migrate your existing localStorage data into your account.

*Delivers:* you + friends log in on any device; private, synced dashboards.

### Phase C — Host & polish
- **C1.** Deploy to Vercel; one shareable URL; installable to a phone home screen.
- **C2.** Visual polish, edge cases, empty states.

*Delivers:* something you can actually send to people.

**First genuinely usable multi-user version = end of Phase B.**

---

## 6. What I'll need from you (and when)

- **Phase B:** you create the **new Supabase project** (I can't make accounts or
  enter credentials) and give me the project URL + public anon key.
- **Phase C:** connect the repo to a **new Vercel project** (I'll walk you through it).
- Nothing needed from you during Phase A.

---

## 7. Defaults I've assumed (tell me if any are wrong)

- **Recurrence** = a preset menu (once, daily, weekdays, weekly on chosen days,
  fortnightly, monthly-by-date), not free-form rules. Enough for real life, far
  simpler to use.
- **All-day / untimed events** supported (birthdays, "call the plumber").
- **Reminders / push notifications:** out of scope for v1 — reliable web push is
  fiddly. Can revisit later.
- **Timezone:** each user's own local time; no cross-timezone handling.
- **Sharing between users:** none — every account is fully private.
- **Data model stays a per-user blob** unless it ever grows into a real product,
  at which point we'd graduate to relational tables.

---

## 8. Next step

Approve this (or flag changes), then I start **Phase A**, beginning with the
rename to Athena. I'll check in at the end of Phase A before any backend work.

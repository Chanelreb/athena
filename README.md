# Athena

A calm, personal life planner — your days and weeks on purpose, plus habits,
goals and a place to park stray thoughts. No build step, no framework.

Being built out from a single-user dashboard into a small multi-user web app for
a few invited people. See **[SPEC.md](SPEC.md)** for the plan and decisions.

## Files

| File | What |
|---|---|
| `index.html` | The HTML shell. Links the stylesheet and script. |
| `styles.css` | All styling. |
| `app.js` | All behaviour — state, storage, the calendar engine, rendering, editing. |
| `serve.js` | A tiny dependency-free static server for local development. |
| `SPEC.md` | The build spec: decisions, architecture, data model, phased plan. |
| `HANDOFF.md` | Original architecture notes from the single-file version (historical). |
| `mesh-dashboard.original.html` | The original single-file dashboard, kept as a reference checkpoint. Not loaded by anything. |

## Running it

Athena loads `styles.css` and `app.js` as separate files, and some browsers block
those over `file://`. So serve the folder over HTTP:

```bash
node serve.js
```

Then open <http://127.0.0.1:8000>. (Pass a port as `node serve.js 3000` to change it.)

## Storage

Today, all state lives in one `localStorage` key (`athena:v2`) as a single JSON
blob, read and written through the `store` object at the top of `app.js`. Phase B
swaps that object for Supabase so each user's blob syncs to their account. See
`SPEC.md`.

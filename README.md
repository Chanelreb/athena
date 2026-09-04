# Mesh Dashboard

A single-page personal operating dashboard. No build step, no dependencies, no
framework — open `index.html` in a browser and it runs.

## Files

| File | What |
|---|---|
| `index.html` | The HTML shell. Links the stylesheet and script. |
| `styles.css` | All styling (page reset + the `#soft-app` styles). |
| `app.js` | All behaviour — state, storage, rollover, rendering, drag. |
| `HANDOFF.md` | Architecture, storage contract, and migration path. **Read this first.** |
| `mesh-dashboard.original.html` | The pre-split single-file version, kept as a reference checkpoint. Not loaded by anything. |

## Running it

Just open `index.html` in a browser. Because it now loads `styles.css` and
`app.js` as separate files, some browsers block those over the `file://`
protocol. If styling or scripts don't load, serve the folder over HTTP instead:

```bash
python -m http.server 8000
```

Then visit <http://localhost:8000>.

## Storage

State lives in one `localStorage` key, `mesh:dashboard:v1`, as a single JSON
blob. All reads and writes go through the `store` object at the top of `app.js`.
See `HANDOFF.md` for the full state shape and the planned migration to a
database.

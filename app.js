(function () {
  'use strict';

  /* ==========================================================================
     Athena — personal life planner
     Data model v2: date-based events with recurrence, per-user (one JSON blob).
     Storage goes through the single `store` object below — swap it for Supabase
     in Phase B. See SPEC.md.
     ========================================================================== */

  const KEY = 'athena:v2';   // also the local offline-cache key

  // Shown in Settings. A device serving an old cached copy of the app reports an
  // old stamp, which is the quickest way to tell "it is broken" from "it is not
  // the version you think it is". Bump this on anything worth identifying.
  //
  // KEEP IN STEP WITH version.json. The running copy compares itself against
  // that file on the server, so if the two drift the check either never fires
  // or fires forever. Both change together, every release.
  const BUILD = '2026-09-11.4';

  // --- Supabase client & auth ---------------------------------------------
  // The publishable key is public by design; row-level security is what keeps
  // each account's data private. Falls back to local-only if config/lib absent.
  const CFG = (typeof window !== 'undefined' && window.ATHENA_SUPABASE) || null;
  const sb = (CFG && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(CFG.url, CFG.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;
  const cloud = !!sb;          // true once we have a Supabase client
  // Settings present but no client means the sign-in library did not load or
  // would not run. That is a broken copy of the app, not a local-only one, and
  // it must not pass silently: silence is what let a phone spend days saving to
  // itself while looking perfectly healthy.
  const bootBroken = !!(CFG && !sb);
  let session = null;          // current auth session (set in boot)

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch(_){ return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(_){} };

  // Storage adapter — the only I/O boundary. When signed in, reads/writes the
  // user's single row in `dashboards`; always write-through to a local cache so
  // the app still opens offline (and to keep working when Supabase is absent).
  // updated_at of the cloud copy we last read or wrote — lets us tell whether
  // another device has changed things since (see syncFromCloud).
  let lastRemoteAt = null;
  // True only once we have genuinely read this account's cloud copy (an empty
  // row counts). Until then we must not save over it, and must not offer setup.
  let cloudLoaded = false;
  let loadFailed = false;
  // Why the last read failed, in the user's own words where possible. A failure
  // screen that cannot say what went wrong is a failure screen nobody can act on.
  let loadError = '';
  // Set when someone chooses to carry on with the copy on this device after a
  // failed read. Safe, because a failed read leaves cloudLoaded false, so saves
  // stay local and can never land on top of a cloud copy we have not seen.
  let workLocal = false;

  const store = {
    get: async () => {
      if (cloud){
        // Never quietly answer with local data when this account has a cloud
        // copy. Pretending the read succeeded is how good data gets overwritten.
        if (!session) throw new Error('not signed in');
        const { data, error } = await sb.from('dashboards')
          .select('data, updated_at').eq('user_id', session.user.id).maybeSingle();
        if (error) throw error;
        return data
          ? { value: JSON.stringify(data.data), updatedAt: data.updated_at, remote: true }
          : { value: null, updatedAt: null, remote: true };
      }
      const v = lsGet(KEY);
      return { value: v, updatedAt: null, remote: false };
    },
    set: async (blob) => {
      lsSet(KEY, blob);                       // write-through offline cache
      if (cloud){
        if (!session) throw new Error('not signed in');
        // Refuse to push over a cloud copy we never managed to read this
        // session: we would be writing on top of who knows what.
        if (!cloudLoaded) throw new Error('cloud not loaded');
        const stamp = new Date().toISOString();
        const { error } = await sb.from('dashboards')
          .upsert({ user_id: session.user.id, data: JSON.parse(blob), updated_at: stamp });
        if (error) throw error;
        lastRemoteAt = stamp;                 // this device is now the latest writer
      }
      return { ok: true };
    }
  };

  const app = document.getElementById('soft-app');
  // Delegated listeners hang off the shell, not the app, because the desktop
  // panels are siblings of #soft-app rather than inside it. Anything attached
  // to the app alone simply would not hear a click in the scratchpad panel.
  const shell = document.getElementById('ath-shell') || app;

  /* ---------- time & date helpers ---------- */
  const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const SD    = { 0:'Sun', 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat' };
  const MON   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const monKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
  function weekKey(d){ const m = new Date(d); m.setHours(0,0,0,0); m.setDate(m.getDate() - ((m.getDay()+6)%7)); return dayKey(m); }
  const parseDay = k => new Date(k + 'T00:00');
  const mins = s => (+s.slice(0,2))*60 + (+s.slice(3));
  const fmtM = m => pad(Math.floor(m/60)) + ':' + pad(m%60);
  function clockOf(s){ let h=+s.slice(0,2); const m=s.slice(3); const ap=h<12?'am':'pm'; h=h%12||12; return h+(m==='00'?'':':'+m)+ap; }
  function dur(m){ const h=Math.floor(m/60), r=m%60; return h?(h+'h'+(r?' '+r+'m':'')):(r+' min'); }
  const daysBetween = (a,b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
  const uid8 = () => Math.random().toString(36).slice(2,8);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  const TICK = '<svg viewBox="0 0 10 10" fill="none"><path d="M1.6 5.2 3.9 7.4 8.4 2.6" stroke="#2C2932" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG0 = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">';

  /* ---------- decorative line drawings (generic, rotate daily) ---------- */
  const MOTIFS = [
    /* sun */    SVG0 + '<circle cx="32" cy="32" r="12"/><path d="M49 32h6M44 44l4.3 4.3M32 49v6M20 44l-4.3 4.3M15 32H9M20 20l-4.3-4.3M32 15V9M44 20l4.3-4.3"/></svg>',
    /* tree */   SVG0 + '<path d="M32 57V33"/><path d="M32 35c-6-3-9-8-8-13M32 33c6-4 9-9 8-14"/><circle cx="22" cy="19" r="7"/><circle cx="42" cy="18" r="8"/><circle cx="32" cy="12" r="7"/><path d="M25 57h14"/></svg>',
    /* leaf */   SVG0 + '<path d="M20 48C20 30 32 16 48 14 46 30 36 46 20 48Z"/><path d="M44 20 24 44"/></svg>',
    /* wave */   SVG0 + '<path d="M7 34c5-4 11-4 16 0s11 4 16 0 11-4 16 0"/><path d="M7 43c5-4 11-4 16 0s11 4 16 0 11-4 16 0"/><path d="M14 22c2-3 4-3 6 0M37 16c1.6-2.4 3.2-2.4 4.8 0"/></svg>',
    /* mountain */ SVG0 + '<path d="M8 48 26 20l10 15 6-8 14 21Z"/><path d="M22 27l4 4 4-6"/></svg>',
    /* cup */    SVG0 + '<path d="M16 26h28v12a10 10 0 0 1-10 10H26a10 10 0 0 1-10-10Z"/><path d="M44 30h5a5 5 0 0 1 0 10h-5"/><path d="M24 14c-2 3 2 5 0 8M32 12c-2 3 2 5 0 8"/></svg>'
  ];
  const MOON = SVG0 + '<path d="M44 38A14 14 0 1 1 30 24A11 11 0 1 0 44 38Z"/><path d="M13 17v6M10 20h6M50 12v5M47.5 14.5h5M17 47v5M14.5 49.5h5"/></svg>';
  const PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+
    '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/></svg>';
  // A settings control should look like a settings control. The daily drawing is
  // lovely and told you nothing about what tapping it would do.
  const COG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+
    '<circle cx="12" cy="12" r="3.2"/>'+
    '<path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.05H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.05-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.05H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.04Z"/></svg>';

  /* ---------- daily lines (generic) ---------- */
  const LINES = [
    'You are the architect. The calendar is only the drawing.',
    'One percent better today. That is the whole strategy.',
    'A system you trust beats ten mornings of willpower.',
    'Big years are small weeks that kept their promises.',
    'Nobody drifts into the life they wanted. They draw it first.',
    'Make today the day yesterday was preparing for.',
    'Kindness compounds faster than any interest rate.',
    'Organised is not tidy. Organised is knowing what comes next.',
    'Success is a hundred ordinary days pointed the same way.',
    'Design the week you want, then go and live inside it.',
    'Yesterday set the floor. Today is where you raise it.',
    'Write it down and your mind is free to think again.',
    'You do not need a bigger week. You need a kept one.',
    'Blueprints before bricks. Draw the week before you live it.',
    'Beat yesterday. It is the only scoreboard worth reading.',
    'Every block you keep makes the next one easier to keep.',
    'The winning is not loud. It is Tuesday, done properly.',
    'You are not reacting to your life. You are designing it.',
    'Today gets one improvement. Tomorrow gets another.',
    'Structure is what freedom looks like once it grows up.',
    'Quiet consistency is the most underrated form of ambition.',
    'Leave today a little better than you found it.',
    'Order is not restriction. It is room to breathe.',
    'A life by design starts with one hour placed on purpose.',
    'Build the week on purpose and the year builds itself.'
  ];

  /* ---------- defaults & starter seed ---------- */
  const DEFAULT_CATS = [
    { id:'personal', label:'Personal', color:'#C4A8CE' },
    { id:'work',     label:'Work',     color:'#8DA9C4' },
    { id:'health',   label:'Health',   color:'#9CC0A9' }
  ];

  // A light, generic starter week for a fresh install (Phase B replaces this
  // with a guided setup). Everything here is ordinary and editable/deletable.
  function seedEvents(){
    const from = weekKey(new Date());
    const wd = [1,2,3,4,5];
    const every = [0,1,2,3,4,5,6];
    const ev = (o) => Object.assign({ id:'ev_'+uid8(), note:'', allDay:false, ex:{}, skip:[] }, o);
    const wk = (weekdays, interval) => ({ freq:'weekly', interval:interval||1, weekdays, monthday:1, from, until:null });
    return [
      // Just "Morning". A routine is now a real thing in Athena, and a block
      // called "Morning routine" sitting beside an actual morning routine is
      // precisely the confusion worth designing out.
      ev({ title:'Morning',         cat:'health',   start:'07:00', end:'07:30', rrule:wk(every) }),
      ev({ title:'Focus block',     cat:'work',     start:'09:00', end:'11:00', rrule:wk(wd) }),
      ev({ title:'Lunch',           cat:'personal', start:'12:30', end:'13:00', rrule:wk(every) }),
      ev({ title:'Movement',        cat:'health',   start:'17:30', end:'18:00', rrule:wk([1,3,5]) }),
      ev({ title:'Dinner',          cat:'personal', start:'18:30', end:'19:30', rrule:wk(every) }),
      ev({ title:'Wind down',       cat:'personal', start:'21:00', end:'21:30', rrule:wk(every) })
    ];
  }
  function seedHabits(){
    return [
      { id:'hb_'+uid8(), label:'Water', cat:'health', target:4 },
      { id:'hb_'+uid8(), label:'Move your body', cat:'health', target:1 }
    ];
  }

  /* ---------- state ---------- */
  const blank = () => ({
    schemaVersion: 2,
    profile: { name:'', timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone || ''), onboarded:false, theme:'dark' },
    categories: DEFAULT_CATS.map(c => Object.assign({}, c)),
    events: [],
    habits: [],
    goals: [],
    // Things to do. A task has no time of its own — it surfaces inside whichever
    // block shares its category. { id, title, note, cat, priority, due, repeat, doneAt }
    tasks: [],
    parked: [],
    // Notes are for keeping, Park is for today's scratch. A note is
    // { id, kind:'text'|'list', title, body, items:[{id,text,done}],
    //   color, cat, pinned, archived, createdAt, updatedAt }
    notes: [],
    // A routine is to habits what a block is to tasks: a container that happens
    // at a time and holds an ordered set of small things.
    // { id, name, time:'HH:MM', weekdays:[0-6], cat, habits:[habitId] }
    routines: [],
    // Minutes actually spent, by day and by what they were spent on.
    // { 'YYYY-MM-DD': { 'ev_abc': 50, 'tk_def': 25 } }
    // Athena leans on estimates everywhere. This is how it finds out whether
    // they were ever any good.
    spent: {},
    completions: {}   // { 'YYYY-MM-DD': { <itemId>: true | <number> } }
  });

  let S = blank();
  let ok = true;
  let view = 'day';
  let openDay = null;                 // week strips: which day is expanded
  let openGoal = null;
  let openBlockTasks = null;          // which block has its task list expanded
  let openBlockLater = null;          // ...and which has its "later" pile open
  let parkOpen = null;                // which parked thought is showing its choices
  // Today and the whole week are the same calendar at two zoom levels, so they
  // share the Day tab. Blocks got the slot that Week used to hold.
  let dayMode = 'today';              // 'today' | 'week'
  let growMode = 'habits';            // Grow tab: 'habits' | 'goals'
  let expanded = (typeof window !== 'undefined' && window.innerWidth >= 900);
  let editing = null;                 // event-editor state, or null
  // Which day/week you're looking at, as an offset in days from today. Day view
  // steps by 1, Week view by 7 (so the weekday stays put when you change week).
  let dayShift = 0;
  const viewDate = () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + dayShift); return d; };
  // The full 7-column grid needs real width; below this we always show strips.
  const canGrid = () => (typeof window !== 'undefined' && window.innerWidth >= 700);
  const gridShown = () => expanded && canGrid();
  // On a phone the week is shown as three readable days by default; the strips
  // (whole-week shape) are still one tap away.
  let weekMode = 'days';              // 'days' | 'strips'
  const phoneGrid = () => !canGrid() && weekMode === 'days';
  const weekShown = () => view === 'day' && dayMode === 'week';

  function firstRun(){
    // The "skip setup" default — a light generic starter. Marks onboarded.
    S.events = seedEvents();
    S.habits = seedHabits();
    S.profile.onboarded = true;
  }

  async function load(){
    let remote = null, reachedRemote = false;
    try {
      const r = await store.get();
      remote = r ? r.value : null;
      lastRemoteAt = r ? r.updatedAt : null;
      reachedRemote = true;
    }
    catch(e){                                        // offline, signed out, or a failed read
      reachedRemote = false;
      loadError = [e && e.message, e && e.hint, e && e.code, e && e.details]
        .filter(Boolean).join(' | ') || String(e);
      if (typeof console !== 'undefined') console.error('Athena load failed:', e);
    }
    cloudLoaded = cloud ? reachedRemote : true;
    const localRaw = lsGet(KEY);

    // If this account lives in the cloud and we could not read it, stop. Do not
    // fall back to a blank slate: that used to show setup again and then save a
    // fresh starter week straight over the real data.
    if (cloud && !reachedRemote){
      loadFailed = true;
      if (localRaw){ try { S = Object.assign(blank(), JSON.parse(localRaw)); } catch(_){} }
      return;
    }
    loadFailed = false;
    loadError = '';
    workLocal = false;      // back on the account; the local-only banner can go

    if (remote){
      // Cloud is the source of truth.
      S = Object.assign(blank(), JSON.parse(remote));
      lsSet(KEY, remote);                            // refresh offline cache
    } else if (localRaw){
      // No cloud copy yet — adopt what's on this device...
      S = Object.assign(blank(), JSON.parse(localRaw));
      if (cloud) save();                             // ...and migrate it up to the account
    }
    // else: genuinely a brand-new account, confirmed against the cloud. Leave it
    // empty and not onboarded so setup runs. Nothing is saved until setup ends.
    if (!S.profile) S.profile = blank().profile;
    if (!S.categories || !S.categories.length) S.categories = DEFAULT_CATS.map(c => Object.assign({}, c));
  }
  let tm = null;
  let savePending = false;
  function save(){
    clearTimeout(tm);
    savePending = true;
    tm = setTimeout(async () => {
      try { await store.set(JSON.stringify(S)); ok = true; }
      catch(e){ ok = false; }
      finally { savePending = false; }
    }, 250);
  }

  // ---- keeping devices honest ----------------------------------------------
  // One JSON blob per account means the last writer wins, so a device sitting on
  // stale state could overwrite newer changes made elsewhere. We pull the cloud
  // copy whenever this device comes back to life (and periodically while open),
  // so it's current before you touch anything.
  let syncing = false;
  async function syncFromCloud(){
    if (!cloud || !session || syncing || savePending) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (userBusy()) return;                       // never yank the UI mid-edit
    syncing = true;
    try {
      const r = await store.get();
      if (r && r.value && r.updatedAt && r.updatedAt !== lastRemoteAt){
        S = Object.assign(blank(), JSON.parse(r.value));
        lastRemoteAt = r.updatedAt;
        lsSet(KEY, r.value);
        if (!S.profile) S.profile = blank().profile;
        if (!S.categories || !S.categories.length) S.categories = DEFAULT_CATS.map(c => Object.assign({}, c));
        applyTheme();
        render();
      }
    } catch(e){ /* offline — try again next time */ }
    finally { syncing = false; }
  }
  if (typeof window !== 'undefined'){
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromCloud(); });
    window.addEventListener('focus', syncFromCloud);
    window.addEventListener('online', syncFromCloud);
    setInterval(syncFromCloud, 60 * 1000);
  }

  // ---- undo -----------------------------------------------------------------
  // Snapshot the whole state before anything destructive; a brief bar offers to
  // put it back. Cheap because the state is one small blob.
  let undoState = null, undoTimer = null;
  function markUndo(label){
    undoState = { label: label, snap: JSON.stringify(S) };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoState = null; render(); }, 7000);
  }
  function doUndo(){
    if (!undoState) return;
    S = Object.assign(blank(), JSON.parse(undoState.snap));
    undoState = null; clearTimeout(undoTimer);
    save(); render();
  }

  /* ---------- theme ----------
     'dark' | 'light' | 'system'. We resolve the choice here and stamp the
     result on <html>, so the CSS only needs one light block. */
  let lightNow = false;               // set whenever the theme resolves; see tint()
  const prefersLight = () => (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-color-scheme: light)').matches : false;
  function themeChoice(){ return (S.profile && S.profile.theme) || 'dark'; }
  function applyTheme(){
    const choice = themeChoice();
    const resolved = choice === 'system' ? (prefersLight() ? 'light' : 'dark') : choice;
    lightNow = (resolved === 'light');
    try {
      document.documentElement.setAttribute('data-theme', resolved);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'light' ? '#FCFAF7' : '#2C2932');
      lsSet('athena:theme', choice);   // so the next boot paints correctly straight away
    } catch(_){}
  }
  // Paint the remembered theme before any data loads, to avoid a flash of the wrong one.
  try {
    const cached = lsGet('athena:theme');
    if (cached){
      const r = cached === 'system' ? (prefersLight() ? 'light' : 'dark') : cached;
      lightNow = (r === 'light');
      document.documentElement.setAttribute('data-theme', r);
    }
  } catch(_){}
  if (typeof window !== 'undefined' && window.matchMedia){
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => { if (themeChoice() === 'system') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  /* ---------- categories ----------
     Category colours are your data, not the theme's, so we can't just swap the
     palette. Instead the stored colour is adjusted on the fly in light mode:
     the same hue, settled to a level that reads on pale stone without going
     dark and heavy. Works for custom colours too, and never touches the data. */
  const shadeCache = {};
  function deepen(hex){
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return hex;
    if (shadeCache[hex]) return shadeCache[hex];
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d){
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    // Soft: the pastels are nudged, not shoved. Enough to read on stone paper,
    // not so far that a week of blocks looks like a bar chart drawn in navy.
    const L = 0.58, S = Math.min(0.44, Math.max(0.30, s * 1.6));
    const c = (1 - Math.abs(2 * L - 1)) * S;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = L - c / 2;
    let rr, gg, bb;
    if (h < 60){ rr = c; gg = x; bb = 0; }
    else if (h < 120){ rr = x; gg = c; bb = 0; }
    else if (h < 180){ rr = 0; gg = c; bb = x; }
    else if (h < 240){ rr = 0; gg = x; bb = c; }
    else if (h < 300){ rr = x; gg = 0; bb = c; }
    else { rr = c; gg = 0; bb = x; }
    const to = v => Math.round((v + mm) * 255).toString(16).padStart(2, '0');
    return (shadeCache[hex] = '#' + to(rr) + to(gg) + to(bb));
  }
  const tint = hex => lightNow ? deepen(hex) : hex;

  const catOf = id => S.categories.find(c => c.id === id) || S.categories[0] || DEFAULT_CATS[0];
  const catColor = id => tint(catOf(id).color);

  /* ==========================================================================
     Guided first-run setup — a brand-new account (not onboarded, no events)
     gets a short, warm flow that builds a starter week from a few answers.
     ========================================================================== */
  let ob = null;   // onboarding state, or null
  // Only offer setup when we have actually confirmed with the cloud that this
  // account is empty. Otherwise a failed read looks identical to a new user.
  const needsOnboarding = () =>
    cloudLoaded && !loadFailed && !(S.profile && S.profile.onboarded) && !((S.events || []).length);

  const OB_CATS = [
    { id:'work',     label:'Work',     color:'#8DA9C4' },
    { id:'study',    label:'Study',    color:'#B0A8CE' },
    { id:'family',   label:'Family',   color:'#C4A8CE' },
    { id:'health',   label:'Health',   color:'#9CC0A9' },
    { id:'home',     label:'Home',     color:'#C4B79A' },
    { id:'admin',    label:'Life admin', color:'#93B0B5' },
    { id:'creative', label:'Creative', color:'#D0A8B0' }
  ];

  // Starting guesses, so nobody faces seven empty boxes. Deliberately modest:
  // too low is a nudge to raise it, too high is a week you resent on sight.
  const OB_PLAN = {
    work:  { hours: 20, days: 5 },  study:    { hours: 10, days: 5 },
    family:{ hours: 10, days: 7 },  health:   { hours:  4, days: 4 },
    home:  { hours:  5, days: 7 },  admin:    { hours:  2, days: 2 },
    creative:{ hours: 4, days: 2 }
  };
  const obPlanDefault = id => Object.assign({ hours: 4, days: 3 }, OB_PLAN[id]);

  // Which weekdays a "3 days a week" answer should mean. Spelled out rather
  // than computed, because an even spread by arithmetic gives you Saturday when
  // you plainly meant Thursday. 0 is Sunday.
  const OB_DAYS = {
    1: [3], 2: [2,4], 3: [1,3,5], 4: [1,2,4,5],
    5: [1,2,3,4,5], 6: [1,2,3,4,5,6], 7: [0,1,2,3,4,5,6]
  };

  // What a category already occupies in a normal week, used to prefill the
  // numbers on a rerun and to work out what is actually missing.
  function obWeeklyMins(catId){
    return (S.events || []).reduce((sum, e) => {
      if (e.cat !== catId || !e.rrule || !e.rrule.weekdays || !e.rrule.weekdays.length) return sum;
      const len = mins(e.end) - mins(e.start);
      if (len <= 0) return sum;
      return sum + (len * e.rrule.weekdays.length) / (e.rrule.interval || 1);
    }, 0);
  }
  function obWeeklyDays(catId){
    const seen = {};
    (S.events || []).forEach(e => {
      if (e.cat === catId && e.rrule && e.rrule.weekdays) e.rrule.weekdays.forEach(d => { seen[d] = 1; });
    });
    return Object.keys(seen).length;
  }

  function obSync(){
    if (!ob) return;
    const g = id => document.getElementById(id);
    if (g('ob_name'))  ob.name  = g('ob_name').value;
    if (g('ob_start')) ob.start = g('ob_start').value || ob.start;
    if (g('ob_end'))   ob.end   = g('ob_end').value || ob.end;
    if (g('ob_newcat')) ob.newcat = g('ob_newcat').value;
    ob.cats.forEach(id => {
      const hh = g('obp_h_' + id), dd = g('obp_d_' + id);
      if (!ob.plan[id]) ob.plan[id] = obPlanDefault(id);
      if (hh) ob.plan[id].hours = Math.max(0, Math.min(80, parseFloat(hh.value) || 0));
      if (dd) ob.plan[id].days  = Math.max(1, Math.min(7, parseInt(dd.value, 10) || 1));
    });
  }

  /* ---- turning hours a week into actual blocks in actual days ----
     The answers are a budget, not a timetable. This turns them into one, by
     walking each weekday and dropping each category into the earliest gap that
     will hold it. Existing blocks are obstacles, never overwritten, so the same
     code serves a first run and a rerun years later. Lunch is treated as a wall
     so nothing is scheduled straight through the middle of the day. */
  const OB_LUNCH = [12 * 60 + 30, 13 * 60];

  function obBusy(weekday){
    const busy = (S.events || [])
      .filter(e => e.rrule && e.rrule.weekdays && e.rrule.weekdays.indexOf(weekday) !== -1)
      .map(e => [mins(e.start), mins(e.end)])
      .filter(x => x[1] > x[0]);
    busy.push(OB_LUNCH.slice());
    return busy.sort((a, b) => a[0] - b[0]);
  }
  // Earliest point in [from,to] with `len` minutes free. Null if there is none.
  function obFirstFit(busy, from, to, len){
    let t = from;
    for (let i = 0; i < busy.length; i++){
      const a = busy[i][0], b = busy[i][1];
      if (b <= t) continue;
      if (a - t >= len) return t;
      if (b > t) t = b;
    }
    return (to - t >= len) ? t : null;
  }

  // The changes setup wants to make, as a list a person can read and veto.
  function obPlanChanges(startT, endT){
    const dayStart = mins(startT), dayEnd = mins(endT);
    const changes = [];
    const busy = {};
    for (let d = 0; d < 7; d++) busy[d] = obBusy(d);

    // Biggest commitments first: the big rocks go in before the sand, or they
    // never fit at all.
    const wants = ob.cats
      .map(id => ({ id: id, hours: (ob.plan[id] || obPlanDefault(id)).hours, days: (ob.plan[id] || obPlanDefault(id)).days }))
      .sort((a, b) => b.hours - a.hours);

    wants.forEach(w => {
      const cat = S.categories.find(c => c.id === w.id);
      const label = cat ? cat.label : w.id;
      const have = obWeeklyMins(w.id);
      const want = Math.round(w.hours * 60);

      if (want >= have + 15){
        let short = want - have;
        const days = OB_DAYS[Math.max(1, Math.min(7, Math.round(w.days)))];
        // Round the per-day slice to a quarter hour so the week reads tidily.
        const per = Math.max(15, Math.round((short / days.length) / 15) * 15);
        days.forEach(d => {
          if (short < 15) return;
          const len = Math.min(per, short);
          const at = obFirstFit(busy[d], dayStart, dayEnd, len);
          if (at === null) return;            // that day is full; try the rest
          changes.push({ kind:'add', cat:w.id, label:label, weekday:d, start:fmtM(at), end:fmtM(at + len), mins:len });
          busy[d].push([at, at + len]);
          busy[d].sort((a, b) => a[0] - b[0]);
          short -= len;
        });
      } else if (want <= have - 15){
        // Asking for less than is already there. Shorten the blocks rather than
        // delete them: the shape of the week is the part someone arranged and
        // cares about, and "you wanted less Health" is a thin reason to take
        // Tuesday evening away entirely. Only drop one when no sensible length
        // is left, which is also what asking for zero means.
        const ratio = want / have;
        (S.events || [])
          .filter(e => e.cat === w.id && e.rrule && e.rrule.weekdays && e.rrule.weekdays.length)
          .forEach(e => {
            const len = mins(e.end) - mins(e.start);
            if (len <= 0) return;
            const cut = Math.round((len * ratio) / 5) * 5;      // to the nearest five minutes
            const base = { cat:w.id, label:label, id:e.id, title:e.title,
                           start:e.start, end:e.end, days:e.rrule.weekdays.slice() };
            if (cut < 15) changes.push(Object.assign({ kind:'drop', mins:len }, base));
            else if (cut < len) changes.push(Object.assign({ kind:'trim', mins:len - cut, newEnd:fmtM(mins(e.start) + cut) }, base));
          });
      }
    });
    return changes;
  }

  function obApplyChanges(changes){
    const from = weekKey(new Date());
    const byDay = {};
    changes.forEach((c, i) => {
      if (ob.skip[i] || c.kind !== 'add') return;
      // Blocks for the same category at the same time collapse into one
      // repeating block rather than seven identical singles.
      const key = c.cat + '|' + c.start + '|' + c.end;
      (byDay[key] = byDay[key] || { c: c, days: [] }).days.push(c.weekday);
    });
    Object.keys(byDay).forEach(k => {
      const g = byDay[k];
      S.events.push({
        id: 'ev_' + uid8(), title: g.c.label, cat: g.c.cat, note: '', allDay: false,
        start: g.c.start, end: g.c.end, date: null, ex: {}, skip: [],
        rrule: { freq:'weekly', interval:1, weekdays:g.days.sort((a,b)=>a-b), monthday:1, from:from, until:null }
      });
    });
    changes.forEach((c, i) => {
      if (ob.skip[i] || c.kind !== 'trim') return;
      const e = S.events.find(x => x.id === c.id);
      if (e) e.end = c.newEnd;
    });
    const drops = {};
    changes.forEach((c, i) => { if (!ob.skip[i] && c.kind === 'drop') drops[c.id] = 1; });
    if (Object.keys(drops).length) S.events = S.events.filter(e => !drops[e.id]);
  }

  // Two small habits, so the Habits tab is not an empty room on day one. Only
  // for a first run, and only if there is somewhere sensible to file them.
  function obSeedHabits(){
    if (ob && ob.rerun) return;
    if ((S.habits || []).length) return;
    const health = S.categories.find(c => /health|fitness/i.test(c.label));
    if (!health) return;
    S.habits = [
      { id:'hb_'+uid8(), label:'Move your body', cat:health.id, target:1 },
      { id:'hb_'+uid8(), label:'Water',          cat:health.id, target:4 }
    ];
  }

  // Categories offered on a rerun: the ones you already have, plus any of the
  // suggestions you have not taken up. Yours come first and start selected.
  function obChips(){
    const list = ob.rerun
      ? S.categories.map(c => ({ id:c.id, label:c.label, color:c.color, mine:true }))
      : [];
    OB_CATS.forEach(c => {
      if (!list.some(x => x.label.toLowerCase() === c.label.toLowerCase())) list.push({ id:c.id, label:c.label, color:c.color });
    });
    (ob.custom || []).forEach(c => {
      if (!list.some(x => x.label.toLowerCase() === c.label.toLowerCase())) list.push(c);
    });
    return list;
  }

  // Nobody's life fits seven suggestions. Colours are handed out from a palette,
  // skipping anything already on screen, so two categories are never the same.
  const OB_PALETTE = ['#A8BFD0','#B7A9CF','#CBA9C6','#9FC3AC','#C9BC9E','#98B4B8','#D3ABB3','#BFB0A0','#A9C2C9','#C7A8A8'];
  function obAddCustom(){
    obSync();
    const raw = (ob.newcat || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    ob.newcat = '';
    if (!raw) { render(); return; }
    const taken = obChips();
    if (taken.some(c => c.label.toLowerCase() === raw.toLowerCase())){
      // Already there under that name; just make sure it is ticked.
      const hit = taken.find(c => c.label.toLowerCase() === raw.toLowerCase());
      if (hit && ob.cats.indexOf(hit.id) === -1) ob.cats.push(hit.id);
      render(); return;
    }
    const used = taken.map(c => (c.color || '').toLowerCase());
    const color = OB_PALETTE.find(c => used.indexOf(c.toLowerCase()) === -1) || OB_PALETTE[taken.length % OB_PALETTE.length];
    const cat = { id: 'c_' + uid8(), label: raw, color: color };
    (ob.custom = ob.custom || []).push(cat);
    ob.cats.push(cat.id);
    ob.plan[cat.id] = obPlanDefault(cat.id);
    render();
  }

  // Settle the name and categories, which both runs share. On a rerun this only
  // ever adds a category: removing one would orphan the blocks and tasks
  // already filed under it, and nobody expects a setup wizard to do that.
  function obCommitProfile(){
    S.profile.name = (ob.name || '').trim().slice(0, 40);
    if (ob.rerun){
      ob.cats.forEach(id => {
        if (S.categories.some(c => c.id === id)) return;
        const src = obChips().find(c => c.id === id);
        if (src) S.categories.push({ id:src.id, label:src.label, color:src.color });
      });
    } else {
      const all = obChips();
      const chosen = ob.cats.length ? ob.cats : ['personal'];
      let cats = chosen.map(id => all.find(c => c.id === id)).filter(Boolean)
                       .map(c => ({ id:c.id, label:c.label, color:c.color }));
      if (!cats.length) cats = DEFAULT_CATS.map(c => Object.assign({}, c));
      S.categories = cats;
    }
  }

  function obFinish(){
    obSync();
    obCommitProfile();
    ob.skip = {};
    obApplyChanges(obPlanChanges(ob.start || '07:00', ob.end || '21:00'));
    obSeedHabits();
    S.profile.onboarded = true;
    ob = null; view = 'day';
    save(); render();
  }

  // A rerun changes an existing week, so it shows its working first and only
  // touches anything once it has been agreed to.
  function obReview(){
    obSync();
    obCommitProfile();               // categories must exist before we schedule
    ob.changes = obPlanChanges(ob.start || '07:00', ob.end || '21:00');
    ob.skip = {};
    ob.step = 5;
    save(); render();
  }

  function obApply(){
    markUndo('Setup changes applied');
    obApplyChanges(ob.changes || []);
    S.profile.onboarded = true;
    ob = null; view = 'blocks';        // land where they can adjust
    save(); render();
  }

  function obStartRerun(){
    const plan = {};
    S.categories.forEach(c => {
      const m = obWeeklyMins(c.id), d = obWeeklyDays(c.id);
      plan[c.id] = m > 0 ? { hours: Math.round(m / 60 * 2) / 2, days: d || 1 } : obPlanDefault(c.id);
    });
    ob = {
      step: 0, rerun: true, name: (S.profile && S.profile.name) || '',
      cats: S.categories.map(c => c.id), plan: plan, custom: [], newcat: '',
      start: '07:00', end: '21:00', changes: [], skip: {}
    };
    settingsOpen = false;
    render();
  }

  function obSkip(){
    obSync();
    S.profile.name = (ob && ob.name ? ob.name : '').trim().slice(0, 40);
    S.categories = DEFAULT_CATS.map(c => Object.assign({}, c));
    firstRun();                 // generic starter, marks onboarded
    ob = null; view = 'day';
    save(); render();
  }

  const DAY3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function onboardingHTML(){
    if (!ob) ob = { step:0, rerun:false, name:(S.profile && S.profile.name) || '', cats:[], plan:{},
                    custom:[], newcat:'', start:'07:00', end:'21:00', changes:[], skip:{} };
    let h = '<div class="ob"><div class="ob-mark">' + MOON + '</div>';
    if (ob.step === 0){
      h += '<h1>'+(ob.rerun ? 'Let\'s reshape your week' : 'Welcome to Athena')+'</h1>';
      h += '<p class="ob-sub">'+(ob.rerun
        ? 'The same few questions, filled in with what you have now. Change whatever you like. Nothing moves until you say so at the end.'
        : 'A calm place to plan your days. A couple of quick questions and it\'s yours.')+'</p>';
      h += '<label class="fld"><span>What should we call you?</span><input id="ob_name" type="text" autocomplete="given-name" placeholder="Your name" value="'+esc(ob.name)+'"></label>';
      h += '<div class="ob-actions"><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
      h += ob.rerun ? '<button class="linkish ob-skip" data-obcancel>Cancel</button>'
                    : '<button class="linkish ob-skip" data-obskip>Skip, just set me up</button>';
    } else if (ob.step === 1){
      h += '<h1>What are your days about?</h1>';
      h += '<p class="ob-sub">'+(ob.rerun
        ? 'Yours are already ticked. Add anything new below, or untick one to leave it out of this round. Nothing gets deleted.'
        : 'Pick a few, and add any of your own below. These become your colour-coded categories, and each one gets a block in your week. Rename, recolour or change them anytime.')+'</p>';
      h += '<div class="ob-chips">' + obChips().map(c =>
        '<button class="ob-chip'+(ob.cats.indexOf(c.id) !== -1 ? ' on' : '')+'" data-obcat="'+c.id+'">'+
        '<span class="cd" style="background:'+tint(c.color)+'"></span>'+esc(c.label)+'</button>').join('') + '</div>';
      h += '<div class="ob-newcat">'+
        '<input id="ob_newcat" type="text" maxlength="24" autocomplete="off" placeholder="Something of your own" value="'+esc(ob.newcat || '')+'">'+
        '<button class="ghost" data-obaddcat>Add</button></div>';
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
    } else if (ob.step === 2){
      h += '<h1>Your rhythm</h1>';
      h += '<p class="ob-sub">Roughly when does your day start and wind down? We\'ll sketch a light week you can reshape, or fill it with your AI later.</p>';
      h += '<div class="fld two"><label><span>Day starts</span><input id="ob_start" type="time" value="'+ob.start+'"></label>'+
        '<label><span>Wind down</span><input id="ob_end" type="time" value="'+ob.end+'"></label></div>';
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
    } else if (ob.step === 3){
      // The budget. Hours a week is how people actually think about their time;
      // days is what turns that into a shape rather than one enormous Monday.
      const chips = obChips();
      h += '<h1>How much time do your days need?</h1>';
      h += '<p class="ob-sub">Roughly is plenty. Athena turns these into blocks and finds room for them between '+
        clockOf(ob.start)+' and '+clockOf(ob.end)+'. You can move anything afterwards.</p>';
      if (!ob.cats.length){
        h += '<p class="ob-sub">Go back a step and pick at least one category.</p>';
      } else {
        h += '<div class="obplan">' + ob.cats.map(id => {
          const c = chips.find(x => x.id === id) || { label:id, color:'#9CC0A9' };
          const p = ob.plan[id] || (ob.plan[id] = obPlanDefault(id));
          return '<div class="obplan-row">'+
            '<span class="obplan-name"><span class="cd" style="background:'+tint(c.color)+'"></span>'+esc(c.label)+'</span>'+
            '<span class="obplan-nums">'+
              '<label><input id="obp_h_'+id+'" type="number" inputmode="decimal" min="0" max="80" step="0.5" value="'+p.hours+'"><span>hrs a week</span></label>'+
              '<label><input id="obp_d_'+id+'" type="number" inputmode="numeric" min="1" max="7" step="1" value="'+p.days+'"><span>days</span></label>'+
            '</span></div>';
        }).join('') + '</div>';
        const tot = ob.cats.reduce((s, id) => s + ((ob.plan[id] || {}).hours || 0), 0);
        h += '<p class="obplan-tot">'+dur(Math.round(tot * 60))+' a week in all, about '+dur(Math.round(tot * 60 / 7))+' a day.</p>';
      }
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
      if (ob.rerun) h += '<button class="linkish ob-skip" data-obcancel>Cancel</button>';
    } else if (ob.step === 5){
      // Rerun only: show the working before touching a week someone lives in.
      const ch = ob.changes || [];
      h += '<h1>Here is what I would change</h1>';
      if (!ch.length){
        h += '<p class="ob-sub">Nothing needs moving. Your week already matches what you asked for.</p>';
        h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obcancel>Done</button></div>';
      } else {
        h += '<p class="ob-sub">Untick anything you would rather leave alone. Nothing changes until you tap Apply, and Undo will still be there afterwards.</p>';
        h += '<div class="obdiff">';
        ch.forEach((c, i) => {
          const on = !ob.skip[i];
          const cat = S.categories.find(x => x.id === c.cat);
          const col = tint(cat ? cat.color : '#9CC0A9');
          const verb = c.kind === 'add' ? 'Add' : c.kind === 'trim' ? 'Shorten' : 'Remove';
          const detail = c.kind === 'add'
            ? DAY3[c.weekday]+', '+clockOf(c.start)+' to '+clockOf(c.end)
            : c.kind === 'trim'
              ? clockOf(c.start)+' to '+clockOf(c.end)+' becomes '+clockOf(c.start)+' to '+clockOf(c.newEnd)+', on '+c.days.map(d => DAY3[d]).join(', ')
              : esc(c.title || c.label)+', '+clockOf(c.start)+' to '+clockOf(c.end)+' on '+c.days.map(d => DAY3[d]).join(', ');
          h += '<button class="obdiff-row'+(on ? ' on' : '')+'" data-obtoggle="'+i+'">'+
            '<span class="obdiff-box">'+(on ? TICK : '')+'</span>'+
            '<span class="cd" style="background:'+col+'"></span>'+
            '<span class="obdiff-txt"><b>'+verb+' '+esc(c.label)+'</b>'+
            '<span>'+detail+'</span></span></button>';
        });
        h += '</div>';
        const kept = ch.filter((c, i) => !ob.skip[i]);
        h += '<p class="obplan-tot">'+kept.length+' of '+ch.length+' selected: '+
          kept.filter(c => c.kind==='add').length+' to add, '+
          kept.filter(c => c.kind==='trim').length+' to shorten, '+
          kept.filter(c => c.kind==='drop').length+' to remove.</p>';
        h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obapply>Apply</button></div>';
        h += '<button class="linkish ob-skip" data-obcancel>Cancel, change nothing</button>';
      }
    } else {
      const cc = S.categories.map(c => tint(c.color));
      const dot = i => '<b style="background:'+(cc[i % (cc.length || 1)] || '#9CC0A9')+'"></b>';
      h += '<h1>How Athena works</h1>';
      h += '<p class="ob-sub">Four pieces, and they fit together so you mostly don\'t have to think about them.</p>';
      h += '<ul class="ob-explain">'+
        '<li>'+dot(0)+'<span><b>Blocks</b> are the shape of your day. Repeating or one-off, they hold your time.</span></li>'+
        '<li>'+dot(1)+'<span><b>Tasks</b> are things to finish. Give one a category and it turns up inside the block that shares it, so you do it while you\'re already in that headspace.</span></li>'+
        '<li>'+dot(2)+'<span><b>Habits</b> are the small daily things you want a streak on.</span></li>'+
        '<li>'+dot(0)+'<span><b>Goals</b> are something bigger with a date, broken into steps that land in your week.</span></li>'+
        '</ul>';
      h += '<div class="ob-callout"><b>The quick way in</b>'+
        '<span>Got a head full of things? Tap <i>Ask your AI</i>, paste in a brain dump, and Athena sorts it into tasks, gives each a category and a priority, then drops them into the blocks where they belong. You approve everything before it lands.</span></div>';
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obfinish>Build my week</button></div>';
    }
    h += '</div>';
    return h;
  }

  /* ==========================================================================
     Recurrence engine — the heart of the calendar.
     occursOn(event, dateObj) → does this event happen on that day?
     eventsOnDate(dateObj)    → resolved, sorted blocks for that day.
     ========================================================================== */
  function occursOn(evt, D){
    const dk = dayKey(D);
    if (evt.skip && evt.skip.indexOf(dk) !== -1) return false;
    const r = evt.rrule;
    if (!r) return evt.date === dk;                 // one-off
    if (dk < r.from) return false;
    if (r.until && dk > r.until) return false;
    if (r.freq === 'daily'){
      return daysBetween(r.from, dk) % (r.interval || 1) === 0;
    }
    if (r.freq === 'weekly'){
      if (!r.weekdays || r.weekdays.indexOf(D.getDay()) === -1) return false;
      const wa = weekKey(parseDay(r.from)), wb = weekKey(D);
      const weeks = Math.round(daysBetween(wa, wb) / 7);
      return weeks % (r.interval || 1) === 0;
    }
    if (r.freq === 'monthly'){
      const anchor = parseDay(r.from);
      const target = r.monthday || anchor.getDate();
      // clamp target to the month's length
      const last = new Date(D.getFullYear(), D.getMonth()+1, 0).getDate();
      if (D.getDate() !== Math.min(target, last)) return false;
      const months = (D.getFullYear()-anchor.getFullYear())*12 + (D.getMonth()-anchor.getMonth());
      return months >= 0 && months % (r.interval || 1) === 0;
    }
    return false;
  }

  function eventsOnDate(D){
    const dk = dayKey(D);
    const out = [];
    (S.events || []).forEach(evt => {
      if (!occursOn(evt, D)) return;
      const o = (evt.ex && evt.ex[dk]) || {};
      out.push({
        id: evt.id,
        uid: evt.id + '@' + dk,
        t: o.title != null ? o.title : evt.title,
        n: o.note  != null ? o.note  : evt.note,
        c: o.cat   != null ? o.cat   : evt.cat,
        allDay: evt.allDay,
        s: o.start != null ? o.start : evt.start,
        e: o.end   != null ? o.end   : evt.end
      });
    });
    out.sort((a,b) => (a.allDay?-1:0)-(b.allDay?-1:0) || mins(a.s||'00:00') - mins(b.s||'00:00'));
    return out;
  }
  const findEvent = id => (S.events || []).find(e => e.id === id);

  // Weekly goal steps that carry a day/time show up on the calendar as blocks,
  // marked as "toward" their goal and tied to that week's completion.
  function stepBlocksOnDate(D){
    const wd = D.getDay(), dk = dayKey(D), out = [];
    (S.goals || []).forEach(g => (g.steps || []).forEach(st => {
      if (st.freq !== 'weekly' || st.time == null) return;   // only scheduled weekly steps
      const day = (st.day == null) ? 1 : st.day;
      if (day !== wd) return;
      const s = st.time || '17:00';
      out.push({
        id: st.id, uid: 'step:' + st.id + '@' + dk,
        t: st.label, n: 'Toward ' + g.title, c: g.cat, allDay: false,
        s: s, e: fmtM(mins(s) + 30), step: { gid: g.id, sid: st.id }
      });
    }));
    return out;
  }
  /* ---- tasks that have been given a time ----
     Most tasks have no time: they are filed by category and turn up inside
     whichever block shares it. Some are appointments, though. Once a task has a
     time it stops being something to fit in and becomes something that happens,
     so it takes its own place on the rail and leaves the block lists alone. */
  // A time only means anything on a particular day. Set one with no date and no
  // repeat and it would belong to no day at all, so pin it to today rather than
  // silently dropping what someone just typed. A time also settles the question
  // the date was asking: this happens then, so "by" no longer applies.
  function normaliseAt(value, tk){
    const at = /^\d{1,2}:\d{2}$/.test(value || '') ? value : null;
    if (!at) return null;
    if (!tk.due && !tk.repeat) tk.due = dayKey(new Date());
    tk.dateType = 'on';
    return at;
  }

  function taskAtOn(tk, D){
    if (!tk.at) return false;
    const dk = dayKey(D);
    if (!tk.repeat) return tk.due === dk;
    const f = tk.repeat.freq;
    if (f === 'daily') return !tk.due || dk >= tk.due;
    if (!tk.due || dk < tk.due) return false;
    const due = parseDay(tk.due);
    if (f === 'weekly') return D.getDay() === due.getDay();
    return D.getDate() === due.getDate();          // monthly
  }
  function taskBlocksOnDate(D){
    const dk = dayKey(D), out = [];
    (S.tasks || []).forEach(tk => {
      if (!taskAtOn(tk, D)) return;
      out.push({
        id: tk.id, uid: 'task:' + tk.id + '@' + dk,
        t: tk.title, n: tk.note || '', c: tk.cat, allDay: false,
        s: tk.at, e: fmtM(Math.min(24 * 60 - 1, mins(tk.at) + (tk.mins || 30))),
        task: tk
      });
    });
    return out;
  }

  // Everything that appears on a given day: real events, scheduled goal steps,
  // and tasks with a time of their own.
  function blocksForDate(D){
    const all = eventsOnDate(D).concat(stepBlocksOnDate(D)).concat(taskBlocksOnDate(D)).concat(routineBlocksOnDate(D));
    all.sort((a,b) => (a.allDay?-1:0)-(b.allDay?-1:0) || mins(a.s||'00:00') - mins(b.s||'00:00'));
    return all;
  }

  /* ---------- completions (per-date tick-offs) ---------- */
  function compVal(id, dk){ const m = S.completions[dk]; return m ? m[id] : undefined; }
  function isDone(id, dk, target){
    const v = compVal(id, dk);
    return target && target > 1 ? (v || 0) >= target : !!v;
  }
  function toggleDone(id, dk){
    const m = S.completions[dk] || (S.completions[dk] = {});
    if (m[id]) delete m[id]; else m[id] = true;
    if (!Object.keys(m).length) delete S.completions[dk];
  }
  function bumpCount(id, dk, target){
    const m = S.completions[dk] || (S.completions[dk] = {});
    m[id] = ((m[id] || 0) + 1) % (target + 1);
    if (!m[id]) delete m[id];
    if (!Object.keys(m).length) delete S.completions[dk];
  }

  /* ---------- the satisfying bit ----------
     Ticking something should feel good. One item at a time gets the "just done"
     treatment, a ring shows the day closing, and finishing the lot earns a
     moment. All of it respects prefers-reduced-motion via CSS. */
  let justDone = null, justDoneTimer = null;
  let celebrate = null, celebrateTimer = null, celebratedFor = null;

  function buzz(ms){
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch(_){}
  }
  // Flag one item so only it animates, and let a task linger a beat before it
  // clears out of the open list.
  function markJustDone(id){
    justDone = id;
    clearTimeout(justDoneTimer);
    justDoneTimer = setTimeout(() => { justDone = null; render(); }, 620);
  }
  // What "the day" means for the ring: today's blocks plus today's habits.
  // Tasks are deliberately excluded, an open task list never empties and a ring
  // that can't fill is discouraging rather than motivating.
  function dayProgress(){
    const now = new Date(), dk = dayKey(now);
    let total = 0, done = 0;
    blocksForDate(now).filter(b => !b.allDay).forEach(b => {
      total++;
      if (b.step ? isDone('w:' + b.step.sid, weekKey(now)) : isDone(b.id, dk)) done++;
    });
    activeHabits(now).forEach(hb => { total++; if (isDone(hb.id, dk, hb.target)) done++; });
    return { done, total };
  }
  // The ring lives on the Day view with its number beside it, not crammed inside
  // a badge in the header where it fought the motif and wrapped.
  function dayProgressHTML(){
    const p = dayProgress();
    if (!p.total) return '';
    const pct = p.done / p.total;
    const R = 22, C = 2 * Math.PI * R;
    const all = p.done === p.total;
    return '<div class="dayprog'+(all ? ' full' : '')+'">'+
      '<div class="pring"><svg viewBox="0 0 52 52" aria-hidden="true">'+
        '<circle class="rbg" cx="26" cy="26" r="'+R+'"></circle>'+
        '<circle class="rfg" cx="26" cy="26" r="'+R+'" stroke-dasharray="'+C.toFixed(1)+'" '+
          'stroke-dashoffset="'+(C * (1 - pct)).toFixed(1)+'"></circle>'+
      '</svg></div>'+
      '<div class="dptxt"><b>'+(all ? 'All ' + p.total : p.done + ' of ' + p.total)+'</b>'+
      '<small>'+(all ? 'kept today' : 'kept today')+'</small></div></div>';
  }
  // Called after any tick. Fires once per day, only on the transition to done.
  function maybeCelebrate(){
    const p = dayProgress();
    const dk = dayKey(new Date());
    if (p.total > 0 && p.done === p.total && celebratedFor !== dk){
      celebratedFor = dk;
      celebrate = 'That is the day, kept.';
      buzz([14, 60, 24]);
      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(() => { celebrate = null; render(); }, 4200);
    }
  }

  /* ---------- tasks ----------
     A one-off task is finished once (doneAt). A recurring one is finished per
     period, on the same completions map habits and goal steps use. */
  const PRIOS = [['high','High'], ['normal','Normal'], ['low','Low']];
  const DATEKINDS = [['by','Due by'], ['on','Do on']];
  const MINOPTS = [[0,'How long?'], [10,'10 min'], [15,'15 min'], [20,'20 min'], [30,'30 min'],
    [45,'45 min'], [60,'1h'], [90,'1h 30m'], [120,'2h'], [180,'3h']];
  const prioRank = p => (p === 'high' ? 0 : p === 'low' ? 2 : 1);
  const periodKeyFor = (freq, d) => freq === 'daily' ? dayKey(d) : freq === 'monthly' ? monKey(d) : weekKey(d);

  function taskDone(tk, d){
    if (!tk.repeat) return !!tk.doneAt;
    return isDone('t:' + tk.id, periodKeyFor(tk.repeat.freq, d));
  }
  function toggleTask(tk, d){
    if (!tk.repeat) tk.doneAt = tk.doneAt ? null : dayKey(d);
    else toggleDone('t:' + tk.id, periodKeyFor(tk.repeat.freq, d));
  }
  const findTask = id => (S.tasks || []).find(x => x.id === id);

  // A task's date means one of two things, and they behave differently:
  //   'on'  this has to happen that day, so it only surfaces that day
  //   'by'  this has to be finished by then, so it surfaces until it is done
  function taskAvailableOn(tk, d){
    if (!tk.due) return true;
    // A "do on" task used to appear on its day and nowhere else, so missing it
    // made it disappear, which is the opposite of what a deadline is for. It
    // now stays from its day onward until it is actually done, and the sorter
    // puts it at the top as overdue. Days before its date still leave it alone.
    if (tk.dateType === 'on') return tk.due <= dayKey(d);
    return true;
  }
  // Urgency first, then priority, then soonest, then oldest.
  function taskSorter(d){
    const today = dayKey(d);
    const rank = tk => {
      if (tk.due && tk.due < today) return 0;                        // overdue
      if (tk.due === today) return tk.dateType === 'on' ? 1 : 2;     // today, fixed before flexible
      return 3;
    };
    return (a, b) => {
      const r = rank(a) - rank(b); if (r) return r;
      const p = prioRank(a.priority) - prioRank(b.priority); if (p) return p;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    };
  }
  // A just-ticked task lingers for a beat so you see it strike through before
  // it clears out of the list.
  const openTasks = d => (S.tasks || []).filter(tk => !taskDone(tk, d) || tk.id === justDone);
  // The tasks a block should offer: same category, outstanding, and actually
  // relevant to that day (a "do on Friday" task stays out of Tuesday's blocks).
  /* Which days after `from` have a block for each category, so we can tell
     "there is nowhere for this to go" apart from "its turn has not come round
     yet". Scanned once per render rather than per task, and capped: past a
     month out, a task with no deadline is not waiting on a block, it is just
     not something Athena should be nagging about today. */
  const HOME_SCAN_DAYS = 31;
  function upcomingHomes(from){
    const out = {}, d = new Date(from);
    d.setDate(d.getDate() + 1);
    for (let i = 0; i < HOME_SCAN_DAYS; i++){
      const dk = dayKey(d), seen = {};
      blocksForDate(d).forEach(b => {
        if (b.step || b.task || seen[b.c]) return;
        seen[b.c] = 1;
        (out[b.c] = out[b.c] || []).push(dk);
      });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  /* Is this a chance worth taking now, or can it wait?
     Deliberately counts chances rather than days: a task due in a fortnight is
     urgent if its category only has one block left before then, and relaxed if
     it has six. A task with no deadline is always worth offering, because a
     block is the only thing that will ever prompt it. */
  function taskIsSoon(tk, d, homes){
    if (!tk.due) return true;
    const today = dayKey(d);
    if (tk.due <= today) return true;                              // overdue or due today
    const chances = (homes[tk.cat] || []).filter(k => k <= tk.due).length;
    if (chances <= 2) return true;                                 // running out of blocks
    return daysBetween(today, tk.due) <= 7;                        // or simply close
  }

  // A task with a time of its own has a place on the rail already, so it never
  // queues inside a block as well.
  const tasksForCat = (catId, d) =>
    openTasks(d).filter(tk => !taskAtOn(tk, d) && tk.cat === catId && taskAvailableOn(tk, d)).sort(taskSorter(d));

  /* ---- placing tasks by hand ----
     A task can be pinned to one block on one day: "do this during Work on
     Thursday". Pinning is per day as well as per block, because a block that
     repeats is a different occasion each time it comes round.

     Autofill is what Athena has always done, filling a block with everything of
     that category. It stays on by default and pinning sits on top of it, so
     dragging never has to be the only way to get a task in front of you. */
  const autofillOn = () => !(S.profile && S.profile.autofill === false);
  const pinnedTo = (tk, b, d) => !!(tk.pin && tk.pin.b === b.id && tk.pin.d === dayKey(d));
  // A pin on this day or a later one means the task has a place. It used to
  // count only on the pinned day itself, so a task placed on Thursday was
  // still being autofilled into Wednesday's block. A pin on an earlier day
  // that was never done has lapsed, and the task is free again.
  const pinLive = (tk, d) => !!(tk.pin && tk.pin.d >= dayKey(d));

  function tasksForBlock(b, d){
    if (b.step || b.task || b.routine) return [];
    const open = openTasks(d).filter(tk => !taskAtOn(tk, d) && taskAvailableOn(tk, d));
    const mine = open.filter(tk => pinnedTo(tk, b, d));
    if (!autofillOn()) return mine.sort(taskSorter(d));
    // Autofill leaves alone anything that already has a place, and anything
    // held back in the list on purpose.
    const auto = open.filter(tk => tk.cat === b.c && !pinLive(tk, d) && !tk.hold);
    return mine.concat(auto).sort(taskSorter(d));
  }

  // What is still waiting to be given a place today.
  function unplacedTasks(d){
    return openTasks(d)
      .filter(tk => !taskAtOn(tk, d) && !pinLive(tk, d) && taskAvailableOn(tk, d))
      .sort(taskSorter(d));
  }

  /* ---- placing a pile of tasks into blocks, by the clock ----
     Autofill offers every task of a category to every block of it, which is
     fine for three tasks and useless for twelve: 4h 45m poured into a 2 hour
     block. This does what a person would. Most urgent first, it puts each task
     in the earliest block of its category with room for it, and when a block
     is full it moves on to the next one. A "do on" task only goes on its day, a
     "due by" task only before its date, and anything already put somewhere by
     hand keeps its room. What will not fit anywhere is held in the list rather
     than dumped back into an overflowing block. */
  const PLACE_HORIZON = 21;
  const placeable = tk => !tk.repeat && !tk.at && !tk.doneAt;

  function placeByCapacity(list, from){
    const start = new Date(from || new Date()); start.setHours(0, 0, 0, 0);
    const now = new Date(), todayK = dayKey(now), nowM = now.getHours() * 60 + now.getMinutes();
    const startK = dayKey(start);
    const ids = {}; list.forEach(tk => { ids[tk.id] = 1; });
    const used = {};
    (S.tasks || []).forEach(tk => {
      if (!tk.pin || ids[tk.id] || tk.doneAt) return;
      const k = tk.pin.b + '|' + tk.pin.d;
      used[k] = (used[k] || 0) + (tk.mins || 30);
    });
    // Every real block of each category over the horizon, in time order.
    const occ = {};
    for (let i = 0; i < PLACE_HORIZON; i++){
      const d = new Date(start); d.setDate(start.getDate() + i);
      const dk = dayKey(d);
      blocksForDate(d).forEach(b => {
        if (b.allDay || b.step || b.task || b.routine) return;
        const s = mins(b.s), e = mins(b.e);
        if (dk === todayK && e <= nowM) return;            // already over
        (occ[b.c] = occ[b.c] || []).push({ id: b.id, dk: dk, s: s, e: e });
      });
    }
    let placed = 0; const blocksUsed = {}; const left = [];
    list.slice().sort(taskSorter(start)).forEach(tk => {
      const len = tk.mins || 30;                           // no estimate: assume half an hour
      let lo = startK, hi = null;
      if (tk.due && tk.due >= startK){
        if (tk.dateType === 'on') lo = hi = tk.due;
        else hi = tk.due;
      }
      const spot = (occ[tk.cat] || []).find(o =>
        o.dk >= lo && (!hi || o.dk <= hi) && (o.e - o.s) - (used[o.id + '|' + o.dk] || 0) >= len);
      if (!spot){ left.push(tk); return; }
      const k = spot.id + '|' + spot.dk;
      used[k] = (used[k] || 0) + len;
      tk.pin = { b: spot.id, d: spot.dk };
      tk.hold = false;
      placed++; blocksUsed[k] = 1;
    });
    left.forEach(tk => { tk.pin = null; tk.hold = true; });
    return { placed: placed, blocks: Object.keys(blocksUsed).length, left: left };
  }

  function placedSummary(r){
    const parts = [];
    if (r.placed) parts.push('Placed ' + r.placed + ' task' + (r.placed !== 1 ? 's' : '') +
      ' across ' + r.blocks + ' block' + (r.blocks !== 1 ? 's' : ''));
    if (r.left.length) parts.push(r.left.length + ' did not fit and ' +
      (r.left.length !== 1 ? 'are' : 'is') + ' waiting in your list');
    return parts.join('. ') || 'Nothing needed placing';
  }
  // Give a bulk change long enough on screen to read, with its undo.
  function announce(label){
    if (!undoState) return;
    undoState.label = label;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoState = null; render(); }, 12000);
  }
  const totalMins = list => list.reduce((a, tk) => a + (tk.mins || 0), 0);

  /* ==========================================================================
     Views
     ========================================================================== */
  const DS = 360, DE = 1290, SPAN = DE - DS;   // day window: 6am → 9:30pm

  function weekTotals(tot){
    const cats = S.categories;
    const all = cats.reduce((a,c) => a + (tot[c.id]||0), 0) || 1;
    let h = '<div class="wtot"><div class="balbar">' + cats.map(c =>
      tot[c.id] ? '<i style="width:'+(tot[c.id]/all*100)+'%;background:'+tint(c.color)+'"></i>' : '').join('') + '</div>';
    h += '<div class="balkey">' + cats.filter(c=>tot[c.id]).map(c =>
      '<span><b style="background:'+tint(c.color)+'"></b>'+esc(c.label)+' '+dur(tot[c.id])+'</span>').join('') + '</div>';
    const committed = cats.reduce((a,c) => a + (tot[c.id]||0), 0);
    h += '<p class="slack" style="padding-top:0">Across the week that is <b>'+dur(committed)+'</b> committed.</p></div>';
    return h;
  }

  // A real time grid over any set of days. Seven of them on a desktop, three on
  // a phone, where seven columns leave about 45px each and nothing is readable.
  function gridHTML(days, now, tot){
    const H = 680, px = m => (m - DS) / SPAN * H;
    const todayIdx = days.findIndex(d => dayKey(d) === dayKey(now));
    const t = todayIdx >= 0 ? (now.getHours()*60 + now.getMinutes()) : -1;
    let h = '<div class="calhead"><span class="sp"></span><span class="hs cols-'+days.length+'">' +
      days.map((d,i) => '<span'+(i===todayIdx?' class="td"':'')+'>'+SD[d.getDay()]+' '+d.getDate()+'</span>').join('') +
      '</span></div>';
    let hrs = '';
    for (let m = DS; m <= DE; m += 60) hrs += '<u style="top:'+px(m)+'px">'+clockOf(pad(Math.floor(m/60))+':00')+'</u>';
    let cols = '';
    days.forEach((dd, pos) => {
      const dk = dayKey(dd);
      let inner = '';
      for (let m = DS + 60; m < DE; m += 60) inner += '<div class="gl" style="top:'+px(m)+'px"></div>';
      blocksForDate(dd).filter(b => !b.allDay).forEach(b => {
        const st = Math.max(mins(b.s), DS), en = Math.min(mins(b.e), DE);
        if (en <= st) return;
        const col = catColor(b.c);
        if (b.step){
          inner += '<button class="cb cbstep" style="top:'+px(st)+'px;height:'+Math.max(20,(en-st)/SPAN*H-2)+'px;'+
            'background:'+col+'1F;border-left-color:'+col+'" data-gotogoal="'+b.step.gid+'">'+
            '<b>'+esc(b.t)+'</b><em>toward a goal</em></button>';
          return;
        }
        tot[b.c] = (tot[b.c]||0) + (mins(b.e) - mins(b.s));
        inner += '<button class="cb" style="top:'+px(st)+'px;height:'+Math.max(20,(en-st)/SPAN*H-2)+'px;'+
          'background:'+col+'2E;border-left-color:'+col+'" data-editinst="'+b.id+'|'+dk+'" '+
          'data-uid="'+b.id+'" data-dk="'+dk+'" data-sm="'+mins(b.s)+'" data-em="'+mins(b.e)+'" data-pos="'+pos+'">'+
          '<b>'+esc(b.t)+'</b><em>'+clockOf(b.s)+'–'+clockOf(b.e)+'</em><i class="rz"></i></button>';
      });
      if (pos === todayIdx && t >= DS && t <= DE) inner += '<div class="cbnow" style="top:'+px(t)+'px"></div>';
      cols += '<div class="calcol'+(pos===todayIdx?' td':'')+'" data-newon="'+dk+'">'+inner+'</div>';
    });
    // the drag handler reads the column dates straight off here
    return h + '<div class="cal"><div class="calhrs" style="height:'+H+'px">'+hrs+'</div>'+
      '<div class="calcols cols-'+days.length+'" data-dates="'+days.map(dayKey).join(',')+'" '+
      'style="height:'+H+'px">'+cols+'</div></div>';
  }

  function weekView(vd, now){
    const ORDER = [1,2,3,4,5,6,0];
    const monday = parseDay(weekKey(vd));
    const dates = {}, blocksByDay = {}, LBL = {};
    ORDER.forEach((d,i) => {
      const dd = new Date(monday); dd.setDate(monday.getDate()+i);
      dates[d] = dd;
      blocksByDay[d] = blocksForDate(dd).filter(b => !b.allDay);
      LBL[d] = SD[d] + ' ' + dd.getDate();
    });
    // The current-time marker only belongs on the week you're actually in.
    const thisWeek = weekKey(vd) === weekKey(now);
    const t = thisWeek ? (now.getHours()*60 + now.getMinutes()) : -1;
    const todayPos = thisWeek ? ORDER.indexOf(now.getDay()) : -1;
    const tot = {};
    let h = '';

    if (gridShown()){                       // desktop: the whole week at once
      h += gridHTML(ORDER.map(d => dates[d]), now, tot);
      h += weekTotals(tot);
      return h;
    }
    if (phoneGrid()){                       // phone: three readable days
      const days = [0,1,2].map(i => { const d = new Date(vd); d.setDate(vd.getDate()+i); return d; });
      h += gridHTML(days, now, tot);
      h += weekTotals(tot);
      return h;
    }

    // mobile strips: the whole week's shape at a glance
    h += '<div class="axis"><span>6am</span><span>9am</span><span>12pm</span><span>3pm</span><span>6pm</span><span>9pm</span></div>';
    ORDER.forEach((d, pos) => {
      const blocks = blocksByDay[d];
      const isToday = pos === todayPos;
      let segs = '';
      blocks.forEach(b => {
        const s = Math.max(mins(b.s), DS), e = Math.min(mins(b.e), DE);
        if (e <= s) return;
        if (!b.step) tot[b.c] = (tot[b.c]||0) + (mins(b.e) - mins(b.s));
        segs += '<i class="'+(b.step?'seg-step':'')+'" style="left:'+((s-DS)/SPAN*100)+'%;width:'+((e-s)/SPAN*100)+'%;background:'+catColor(b.c)+'"></i>';
      });
      if (isToday && t >= DS && t <= DE) segs += '<span class="wnow" style="left:'+((t-DS)/SPAN*100)+'%"></span>';
      h += '<div class="wrow'+(isToday?' today':'')+'"><span class="wday">'+LBL[d]+'</span>'+
        '<button class="wbar" data-day="'+d+'">'+segs+'</button></div>';
      if (openDay === d){
        h += '<div class="wlist">' + (blocks.length ? blocks.map(b =>
          '<button class="wl"'+(b.step ? ' data-gotogoal="'+b.step.gid+'"' : ' data-editinst="'+b.id+'|'+dayKey(dates[d])+'"')+'>'+
          '<span class="sw" style="background:'+catColor(b.c)+'"></span><span>'+esc(b.t)+(b.step?' <em class="steptag">· goal</em>':'')+'</span>'+
          '<em>'+clockOf(b.s)+'</em></button>').join('')
          : '<p class="park-empty" style="margin:0">Nothing on this day.</p>') +
          '<button class="wl wl-add" data-newon="'+dayKey(dates[d])+'">+ Add something</button></div>';
      }
    });
    h += weekTotals(tot);
    return h;
  }

  /* ---------- the whole rhythm: every block in one place ----------
     Blocks are otherwise only reachable on the day they fall on, so this is
     where you see and reshape the shape of your week. */
  function blocksManagerHTML(now){
    const today = dayKey(now);
    const all = S.events || [];
    const byTime = (a,b) => mins(a.start || '00:00') - mins(b.start || '00:00');
    const repeating = all.filter(e => e.rrule).slice().sort(byTime);
    const oneoff = all.filter(e => !e.rrule && e.date && e.date >= today)
      .slice().sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byTime(a,b)));
    const past = all.filter(e => !e.rrule && e.date && e.date < today).length;

    // A block is a piece of time, so draw it as one: the category colour down
    // its edge, the hours as the headline, a height that grows with how long it
    // runs, and the week it repeats on shown as seven days. Listed as plain rows
    // they read as tasks, which is exactly the wrong idea.
    const DAY1 = ['S','M','T','W','T','F','S'];
    const when = e => {
      if (!e.rrule){
        const x = parseDay(e.date);
        return '<span class="bcard-once">'+DAYS[x.getDay()]+' '+x.getDate()+' '+SHORT[x.getMonth()]+'</span>';
      }
      if (e.rrule.freq === 'monthly') return '<span class="bcard-once">Monthly, day '+(e.rrule.monthday || 1)+'</span>';
      const on = e.rrule.freq === 'daily' ? [0,1,2,3,4,5,6] : (e.rrule.weekdays || []);
      return '<span class="bcard-days'+(e.rrule.interval === 2 ? ' fort' : '')+'">'+
        DAY1.map((d, i) => '<span class="'+(on.indexOf(i) !== -1 ? 'on' : '')+'">'+d+'</span>').join('')+
        (e.rrule.interval === 2 ? '<em>every 2nd week</em>' : '')+'</span>';
    };
    const row = (e, dateCtx) => {
      const len = e.allDay ? 0 : Math.max(0, mins(e.end) - mins(e.start));
      // Longer blocks stand taller, but gently: a four hour block should read as
      // bigger than a half hour one without pushing everything else off screen.
      const tall = Math.round(Math.min(156, 76 + len * 0.19));
      return '<div class="bcard" style="--bc:'+catColor(e.cat)+';--bh:'+tall+'px">'+
        '<span class="bcard-edge"></span>'+
        '<button class="bcard-main" data-editinst="'+e.id+'|'+dateCtx+'">'+
          '<span class="bcard-top"><span class="bcard-title">'+esc(e.title)+'</span>'+
          '<span class="bcard-len">'+(e.allDay ? 'All day' : dur(len))+'</span></span>'+
          '<span class="bcard-time">'+(e.allDay ? '' : clockOf(e.start)+' to '+clockOf(e.end))+'</span>'+
          when(e)+
        '</button>'+
        '<button class="bcard-del" data-delevent="'+e.id+'" aria-label="Remove block">×</button>'+
      '</div>';
    };

    let h = '<p class="slack">Everything that shapes your week. Tap one to change it, or add another.</p>';
    if (!all.length){
      h += '<p class="park-empty">No blocks yet. Add the things that give your day its shape, like a morning routine or a focus block.</p>';
    }
    if (repeating.length){
      h += '<h2>Repeating <span class="tcount">'+repeating.length+'</span></h2>';
      h += '<div class="blist">' + repeating.map(e => row(e, today)).join('') + '</div>';
    }
    if (oneoff.length){
      h += '<h2>Coming up once <span class="tcount">'+oneoff.length+'</span></h2>';
      h += '<div class="blist">' + oneoff.map(e => row(e, e.date)).join('') + '</div>';
    }
    h += '<div class="dayadd" style="margin-top:18px"><button data-newon="'+today+'">+ Add a block</button></div>';
    if (past) h += '<p class="slack" style="padding-top:14px">'+past+' one-off '+(past === 1 ? 'block has' : 'blocks have')+' already passed and are hidden here.</p>';
    return h;
  }

  /* How tall a thing on the rail should be.
     Not strictly proportional. A ten minute block still has to be tappable and
     a four hour one must not need scrolling past, so both ends are clamped and
     the middle is linear. The point is that the difference reads, not that a
     pixel is a minute.

     The slope is set so an hour lands just above the height a card occupies
     anyway, about 90px. Any gentler and everything under two hours sits at that
     floor and the difference never shows, which was the whole point. */
  const blockHeight = len => Math.round(Math.min(176, Math.max(56, 59 + len * 0.489)));
  const gapHeight   = len => Math.round(Math.min(120, Math.max(34, 26 + len * 0.30)));

  /* ==========================================================================
     The day as a grid.
     The same drawing as the week, one day wide: real hour lines, blocks placed
     and sized by the clock, a line at now. Because it is genuinely proportional
     here, the lines can be drawn and be right.

     A block is wide enough to hold its own detail, so what used to sit in a
     list lives inside the block: the tick, the time, and the tasks waiting in
     it. Overlapping blocks share the width rather than hiding each other.
     ========================================================================== */
  const DAY_H = 1120;                       // 30 minutes is about 36px
  let openDayBlock = null;                  // which block has its detail open

  // Blocks that overlap each other share the width. Worked out per cluster, so
  // one clash at 9am does not squeeze the whole day into half-width columns.
  function layOut(list){
    const items = list.map(b => ({ b: b, s: Math.max(mins(b.s), DS), e: Math.min(mins(b.e), DE) }))
      .filter(x => x.e > x.s).sort((a, b) => a.s - b.s || b.e - a.e);
    let i = 0;
    while (i < items.length){
      let end = items[i].e, j = i + 1;
      while (j < items.length && items[j].s < end){ end = Math.max(end, items[j].e); j++; }
      const cluster = items.slice(i, j);
      const lanes = [];
      cluster.forEach(x => {
        let lane = 0;
        while (lane < lanes.length && lanes[lane] > x.s) lane++;
        lanes[lane] = x.e;
        x.lane = lane;
      });
      cluster.forEach(x => { x.of = lanes.length; });
      i = j;
    }
    return items;
  }

  function dayGridHTML(vd, now, soonHomes){
    const dk = dayKey(vd);
    const isToday = dk === dayKey(now);
    const t = isToday ? (now.getHours() * 60 + now.getMinutes()) : -1;
    const px = m => (m - DS) / SPAN * DAY_H;
    const all = blocksForDate(vd);
    const allDay = all.filter(b => b.allDay);
    const laid = layOut(all.filter(b => !b.allDay));
    // Outline the block whose contents are showing, so you can see which it is.
    const shown = detailBlock(vd, now), shownKey = shown ? String(shown.uid || shown.id) : '';

    let h = '';
    if (allDay.length){
      h += '<div class="allday">' + allDay.map(b =>
        '<button class="adchip" data-editinst="'+b.id+'|'+dk+'" style="border-color:'+catColor(b.c)+'55">'+
        '<span class="sw" style="background:'+catColor(b.c)+'"></span>'+esc(b.t)+'</button>').join('') + '</div>';
    }

    let hrs = '', lines = '';
    for (let m = DS; m <= DE; m += 60){
      hrs += '<u style="top:'+px(m)+'px">'+clockOf(pad(Math.floor(m/60))+':00')+'</u>';
      if (m > DS) lines += '<div class="gl" style="top:'+px(m)+'px"></div>';
    }

    let body = lines;
    laid.forEach(x => {
      const b = x.b, hgt = Math.max(22, px(x.e) - px(x.s) - 2);
      const col = catColor(b.c);
      const isStep = !!b.step, isTask = !!b.task, isRoutine = !!b.routine;
      const rp = isRoutine ? routineProgress(b.routine, vd) : null;
      const done = isStep ? isDone('w:' + b.step.sid, weekKey(vd))
                 : isTask ? taskDone(b.task, vd)
                 : isRoutine ? (rp.total > 0 && rp.done === rp.total)
                 : isDone(b.id, dk);
      const live = t >= x.s && t < x.e;
      const doneAct = isStep ? 'data-stepweek="'+b.step.gid+':'+b.step.sid+'|'+dk+'"'
                    : isTask ? 'data-tasktoggle="'+b.task.id+'|'+dk+'"'
                    : isRoutine ? 'data-routinedone="'+b.routine.id+'|'+dk+'"'
                    : 'data-done="'+b.id+'|'+dk+'"';
      const waiting = tasksForBlock(b, vd).filter(tk => taskIsSoon(tk, vd, soonHomes) || pinnedTo(tk, b, vd));
      const w = 100 / (x.of || 1), left = w * (x.lane || 0);
      body += '<div class="dblk'+(done ? ' done' : '')+(live ? ' live' : '')+(justDone === b.id ? ' just' : '')+
        (shownKey === String(b.uid || b.id) ? ' sel' : '')+
        // Picked means you chose it, not just that it is on now. On a touch
        // screen only a picked block can be moved.
        (openDayBlock && openDayBlock === String(b.uid || b.id) ? ' picked' : '')+'" '+
        'data-blockid="'+esc(String(b.uid || b.id))+'"'+
        // An appointment can be dragged back to the pile to lose its time.
        (isTask ? ' draggable="true" data-dragtask="'+b.task.id+'"' : '')+
        ' style="top:'+px(x.s)+'px;height:'+hgt+'px;left:calc('+left+'% + 3px);width:calc('+w+'% - 6px);'+
        'background:'+col+'2E;border-left-color:'+col+'">'+
        (hgt >= 30 ? '<button class="dtick" '+doneAct+' style="'+(done ? 'background:'+col+';border-color:'+col : 'border-color:'+col)+'" '+
          'aria-label="'+(done ? 'Undo ' : 'Tick off ')+esc(b.t)+'">'+TICK+'</button>' : '')+
        '<button class="dmain" data-dayblock="'+esc(b.uid || b.id)+'">'+
          '<b>'+esc(b.t)+(isRoutine ? ' <em class="dcount">'+rp.done+'/'+rp.total+'</em>' : '')+'</b>'+
          (hgt >= 46 ? '<em>'+clockOf(b.s)+' – '+clockOf(b.e)+'</em>' : '')+
          (waiting.length && hgt >= 62 ? '<em class="dtasks">'+waiting.length+' task'+(waiting.length !== 1 ? 's' : '')+
            (totalMins(waiting) ? ' · '+dur(totalMins(waiting)) : '')+'</em>' : '')+
        '</button>'+
        // A goal step belongs to its goal, so it is not draggable here.
        // Everything else can be moved, and pulled longer from its bottom edge.
        (isStep ? '' : '<i class="drz"></i>')+
        '</div>';
    });
    if (isToday && t >= DS && t <= DE) body += '<div class="cbnow" style="top:'+px(t)+'px"></div>';

    h += '<div class="daygrid"><div class="calhrs" style="height:'+DAY_H+'px">'+hrs+'</div>'+
      '<div class="dcol" style="height:'+DAY_H+'px" data-newon="'+dk+'">'+body+'</div></div>';
    return h;
  }

  /* What will not fit inside a block. A half hour block is about 36px tall,
     which holds a name and a time and nothing else, so the tasks waiting in it
     and a routine's steps open underneath the grid rather than being crammed in
     or, worse, lost. Defaults to whatever is happening now, so on most days the
     right thing is already open. */
  // Which block's detail is showing: the one you picked, or before you have
  // picked one, whatever is happening now. '' means you closed it.
  function detailBlock(vd, now){
    const t = dayKey(vd) === dayKey(now) ? (now.getHours() * 60 + now.getMinutes()) : -1;
    const blocks = blocksForDate(vd).filter(b => !b.allDay);
    let b = openDayBlock ? blocks.find(x => String(x.uid || x.id) === openDayBlock) : null;
    if (!b && openDayBlock === null) b = blocks.find(x => t >= mins(x.s) && t < mins(x.e));
    return b || null;
  }

  function dayDetailHTML(vd, now, soonHomes){
    const dk = dayKey(vd);
    const isToday = dk === dayKey(now);
    const t = isToday ? (now.getHours() * 60 + now.getMinutes()) : -1;
    const key = b => String(b.uid || b.id);
    const b = detailBlock(vd, now);
    if (!b) return '';

    const col = catColor(b.c);
    const live = t >= mins(b.s) && t < mins(b.e);
    const ref = b.task ? 'tk_' + b.task.id : (b.routine ? 'ro_' + b.routine.id : b.id);
    const spent = spentOnDay(ref, dk), planned = mins(b.e) - mins(b.s);
    let h = '<div class="ddet" style="--dc:'+col+'">'+
      '<div class="ddet-h"><b>'+esc(b.t)+'</b><span>'+clockOf(b.s)+' – '+clockOf(b.e)+
      (live ? ' · now' : '')+
      (spent ? ' · <b class="dspent'+(spent > planned * 1.25 ? ' over' : '')+'">'+dur(spent)+' tracked</b>' : '')+'</span>'+
      '<button class="ddet-x" data-dayclose aria-label="Close">×</button></div>';

    if (b.routine){
      const hs = routineHabits(b.routine);
      h += hs.length
        ? '<div class="rsteps">' + hs.map(hb => {
            const hcol = catColor(hb.c);
            if (hb.target){
              const v = compVal(hb.id, dk) || 0;
              let pips = '';
              for (let i = 0; i < hb.target; i++)
                pips += '<span class="pip'+(i<v?' on':'')+'" style="'+(i<v?'background:'+hcol+';border-color:'+hcol:'')+'"></span>';
              return '<button class="rstep'+(v>=hb.target?' done':'')+'" data-pip="'+hb.id+':'+hb.target+'">'+
                '<span class="rmark" style="border-color:'+hcol+'"></span><span class="rl">'+esc(hb.l)+'</span>'+
                '<span class="pips">'+pips+'</span></button>';
            }
            const on = isDone(hb.id, dk);
            return '<button class="rstep'+(on?' done':'')+(justDone===hb.id?' just':'')+'" data-done="'+hb.id+'">'+
              '<span class="rmark" style="'+(on?'background:'+hcol+';border-color:'+hcol:'border-color:'+hcol)+'">'+TICK+'</span>'+
              '<span class="rl">'+esc(hb.l)+'</span></button>';
          }).join('') + '</div>'
        : '<p class="tfit quiet">No habits in this routine yet.</p>';
      return h + '<div class="ddet-act"><button class="linkish" data-gotoroutine="'+b.routine.id+'">Edit this routine</button></div></div>';
    }
    if (b.step)
      return h + '<p class="tfit quiet">A step toward a goal.</p>'+
        '<div class="ddet-act"><button class="linkish" data-gotogoal="'+b.step.gid+'">Open the goal</button></div></div>';
    if (b.task)
      return h + '<p class="tfit quiet">An appointment: a task with a time of its own.</p>'+
        '<div class="ddet-act"><button class="linkish" data-taskedit="'+b.task.id+'">Edit this task</button></div></div>';

    const bt = tasksForBlock(b, vd);
    // Something you put here by hand is never folded away as "later". You have
    // already said this is where it goes.
    const soon = bt.filter(tk => taskIsSoon(tk, vd, soonHomes) || pinnedTo(tk, b, vd));
    const later = bt.filter(tk => soon.indexOf(tk) === -1);
    const est = totalMins(soon), room = mins(b.e) - mins(b.s);
    if (soon.length){
      if (est) h += '<div class="tfit'+(est > room ? ' over' : '')+'">'+
        (est > room ? dur(est)+' of tasks, only '+dur(room)+' here'
                    : dur(est)+' of tasks in a '+dur(room)+' block')+'</div>';
      // Saying it is overfull without offering to fix it is only half helpful.
      if (est > room)
        h += '<button class="linkish spreadbtn" data-spread="'+esc(key(b))+'">Keep what fits here, move the rest to the next '+
          esc(catOf(b.c).label)+' blocks</button>';
      h += '<div class="tlist inblock">'+soon.map(tk => taskRow(tk, vd, true)).join('')+'</div>';
    } else {
      h += '<p class="tfit quiet">Nothing waiting in '+esc(catOf(b.c).label)+' right now.</p>';
    }
    if (later.length){
      const open = openBlockLater === key(b);
      h += '<button class="taskchip later'+(open?' on':'')+'" data-blocklater="'+key(b)+'">+'+later.length+' later<em>'+(open?'▴':'▾')+'</em></button>';
      if (open) h += '<div class="tlist inblock">'+later.map(tk => taskRow(tk, vd, true)).join('')+'</div>';
    }
    return h + '<div class="ddet-act"><button class="linkish" data-editinst="'+b.id+'|'+dk+'">Edit this block</button></div></div>';
  }

  /* The longest stretch of blocks with no real gap between them. Athena can see
     this coming and it costs nothing to mention it, which is a kinder thing to
     do than let someone find out at four o'clock. */
  function longestRun(blocks){
    const list = blocks.filter(b => !b.allDay).slice().sort((a, b) => mins(a.s) - mins(b.s));
    let best = null, from = null, to = null;
    list.forEach(b => {
      const s = mins(b.s), e = mins(b.e);
      if (from === null){ from = s; to = e; }
      else if (s - to <= 10){ to = Math.max(to, e); }        // a ten minute gap is not a break
      else { if (!best || to - from > best.mins) best = { mins: to - from, from: fmtM(from), at: fmtM(to) }; from = s; to = e; }
    });
    if (from !== null && (!best || to - from > best.mins)) best = { mins: to - from, from: fmtM(from), at: fmtM(to) };
    return best;
  }

  /* ---- how the day actually went ----
     Athena collects all of this and has never once shown it back. A day you
     kept is worth seeing whole, and a day you did not is worth seeing honestly
     rather than letting it roll quietly into tomorrow. */
  let reviewOpen = false;

  function dayReviewHTML(vd){
    const dk = dayKey(vd);
    const blocks = blocksForDate(vd).filter(b => !b.allDay);
    const kept = [], missed = [];
    blocks.forEach(b => {
      let done;
      if (b.step) done = isDone('w:' + b.step.sid, weekKey(vd));
      else if (b.task) done = taskDone(b.task, vd);
      else if (b.routine){ const p = routineProgress(b.routine, vd); done = p.total > 0 && p.done === p.total; }
      else done = isDone(b.id, dk);
      (done ? kept : missed).push(b);
    });
    const habits = activeHabits(vd);
    const habitsDone = habits.filter(hb => isDone(hb.id, dk, hb.target));
    const tasksDone = (S.tasks || []).filter(tk => taskDone(tk, vd) && (tk.doneAt === dk || !!tk.repeat));

    // Planned against tracked, by category. This is the number that makes every
    // estimate in Athena mean something.
    const spent = spentDay(dk), byCat = {};
    Object.keys(spent).forEach(ref => {
      let cat = null;
      if (ref.indexOf('tk_') === 0){ const tk = findTask(ref.slice(3)); cat = tk && tk.cat; }
      else if (ref.indexOf('ro_') === 0){ const r = routinesAll().find(x => x.id === ref.slice(3)); cat = r && r.cat; }
      else { const ev = findEvent(ref); cat = ev && ev.cat; }
      byCat[cat || 'other'] = (byCat[cat || 'other'] || 0) + spent[ref];
    });
    const tracked = Object.keys(byCat).reduce((a, k) => a + byCat[k], 0);
    const planned = blocks.filter(b => !b.step && !b.task).reduce((a, b) => a + (mins(b.e) - mins(b.s)), 0);

    let h = '<div class="review"><div class="review-h"><b>How today went</b>'+
      '<button class="ddet-x" data-reviewclose aria-label="Close">×</button></div>';
    h += '<div class="rvrow"><span class="rvn">'+kept.length+'</span><span class="rvl">of '+blocks.length+' block'+(blocks.length!==1?'s':'')+' kept</span></div>';
    if (habits.length)
      h += '<div class="rvrow"><span class="rvn">'+habitsDone.length+'</span><span class="rvl">of '+habits.length+' habit'+(habits.length!==1?'s':'')+'</span></div>';
    if (tasksDone.length)
      h += '<div class="rvrow"><span class="rvn">'+tasksDone.length+'</span><span class="rvl">task'+(tasksDone.length!==1?'s':'')+' finished</span></div>';

    if (tracked){
      h += '<div class="rvbar-h">'+dur(tracked)+' tracked'+(planned ? ' against '+dur(planned)+' planned' : '')+'</div>';
      h += '<div class="balbar">' + Object.keys(byCat).map(cid => {
        const c = S.categories.find(x => x.id === cid);
        return '<i style="width:'+(byCat[cid]/tracked*100)+'%;background:'+(c ? tint(c.color) : '#8A867F')+'"></i>';
      }).join('') + '</div>';
      h += '<div class="balkey">' + Object.keys(byCat).map(cid => {
        const c = S.categories.find(x => x.id === cid);
        return '<span><b style="background:'+(c ? tint(c.color) : '#8A867F')+'"></b>'+
          esc(c ? c.label : 'Other')+' '+dur(byCat[cid])+'</span>';
      }).join('') + '</div>';
    } else {
      h += '<p class="tfit quiet">No time tracked today. Aim the focus timer at a block and this fills itself in.</p>';
    }

    if (missed.length){
      h += '<div class="rvbar-h">Left undone</div><ul class="rvlist">' +
        missed.slice(0, 6).map(b => '<li>'+esc(b.t)+'<em>'+clockOf(b.s)+'</em></li>').join('') +
        (missed.length > 6 ? '<li class="more">and '+(missed.length - 6)+' more</li>' : '') + '</ul>';
    } else if (blocks.length){
      h += '<p class="tfit quiet">Every block kept. That is the whole day.</p>';
    }
    return h + '</div>';
  }

  function dayRail(vd, now){
    const isToday = dayKey(vd) === dayKey(now);
    // Only "today" has a live moment; other days render as plain, unstyled time.
    const t = isToday ? (now.getHours()*60 + now.getMinutes()) : -1;
    const dk = dayKey(vd);
    const all = blocksForDate(vd);
    const allDay = all.filter(b => b.allDay);
    const blocks = all.filter(b => !b.allDay);

    // Scanned once here: both the block queues and the "nowhere to go" list
    // need to know when each category next has a block.
    const soon = upcomingHomes(vd);
    const items = [];
    blocks.forEach((b,i) => {
      items.push({ type:'block', b:b });
      const nx = blocks[i+1];
      if (nx){ const g = mins(nx.s) - mins(b.e); if (g >= 30) items.push({ type:'gap', from:mins(b.e), to:mins(nx.s), next:nx }); }
    });
    const openTotal = items.filter(x=>x.type==='gap').reduce((a,x)=>a+(x.to-x.from),0);
    // Goal steps and timed tasks don't count as "booked": both commonly sit
    // inside a block that already claimed that time, and counting them would
    // book the same hour twice.
    const timed = blocks.filter(b => !b.step && !b.task);
    const booked = timed.reduce((a,b)=>a+(mins(b.e)-mins(b.s)),0);
    const split = {};
    timed.forEach(b => { split[b.c] = (split[b.c]||0) + (mins(b.e)-mins(b.s)); });

    let h = '';
    if (isToday) h += dayProgressHTML();   // progress is about today, not a day you're browsing
    if (booked){
      h += '<p class="slack">Today asks for <b>'+dur(booked)+'</b>, and leaves <b>'+dur(openTotal)+'</b> open in between. There is room.</p>';
      h += '<div class="balbar">' + S.categories.map(c =>
        split[c.id] ? '<i style="width:'+(split[c.id]/booked*100)+'%;background:'+tint(c.color)+'"></i>' : '').join('') + '</div>';
      h += '<div class="balkey">' + S.categories.filter(c=>split[c.id]).map(c =>
        '<span><b style="background:'+tint(c.color)+'"></b>'+esc(c.label)+' '+dur(split[c.id])+'</span>').join('') + '</div>';
    } else {
      h += '<p class="slack">Nothing scheduled '+(isToday ? 'today' : 'this day')+'. '+
        '<button class="linkish" data-newon="'+dk+'">Add something</button>, or enjoy the open day.</p>';
    }

    // A long unbroken run is worth noticing before you live it, not after.
    const run = longestRun(blocks);
    if (run && run.mins >= 180)
      h += '<p class="breakhint">'+dur(run.mins)+' back to back from '+clockOf(run.from)+
        '. <button class="linkish" data-addbreak="'+run.at+'|'+dk+'">Put a break in</button></p>';

    // The day drawn as a grid: hour lines, blocks placed and sized by the clock,
    // a line at now. Detail that will not fit inside a block opens underneath it.
    h += dayGridHTML(vd, now, soon);
    // On a wide screen the detail lives in the right-hand panel, beside the
    // grid. Drawn here as well, it would sit a whole day's height below, out
    // of sight, looking like it had not changed.
    if (!panelsOn()) h += dayDetailHTML(vd, now, soon);

    // On a phone, the block you tapped gets a bar at the foot of the screen.
    // Tapping does not scroll you down to the detail, because that would carry
    // the block away just as you went to move it. The bar offers the jump.
    if (!panelsOn() && openDayBlock){
      const pb = detailBlock(vd, now);
      if (pb){
        const n = (pb.step || pb.task || pb.routine) ? 0 :
          tasksForBlock(pb, vd).filter(tk => taskIsSoon(tk, vd, soon) || pinnedTo(tk, pb, vd)).length;
        h += '<div class="pickbar" style="--dc:'+catColor(pb.c)+'">'+
          '<span class="pb-t"><b>'+esc(pb.t)+'</b>'+(pb.step ? '' : '<em>Drag it to move it</em>')+'</span>'+
          '<button class="pb-go" data-blkjump>'+(n ? n+' task'+(n !== 1 ? 's' : '') : 'Details')+' ↓</button>'+
          '<button class="pb-x" data-dayclose aria-label="Put it down">×</button></div>';
      }
    }

    // Athena promises that tasks find their own way into your day. When a task's
    // category has no block today there is nowhere for it to land, and it would
    // otherwise vanish from this screen entirely. Say so, rather than quietly
    // breaking the promise.
    const blockedCats = {};
    // All-day blocks count as a home. Goal steps and timed tasks do not: neither
    // collects a queue of its own, so neither is anywhere a task can land.
    all.forEach(b => { if (!b.step && !b.task) blockedCats[b.c] = 1; });
    // "No block today" is only worth saying when there is no block coming
    // either. A Life admin task with a Life admin block tomorrow and a deadline
    // next week is not stranded, it is simply not today's problem, and flagging
    // it here just teaches people to ignore this section.
    const homeless = openTasks(vd)
      .filter(tk => {
        // taskAtOn rather than tk.at: an appointment whose day has been and gone
        // has no slot today, so it is back to needing somewhere to go.
        // taskAtOn rather than tk.at: an appointment whose day has been and gone
        // has no slot today, so it is back to needing somewhere to go.
        if (taskAtOn(tk, vd) || blockedCats[tk.cat] || !taskAvailableOn(tk, vd)) return false;
        const next = (soon[tk.cat] || [])[0];
        // Overdue falls out of this on its own: a block coming tomorrow is not
        // "in time" for something that was due yesterday.
        return !(next && (!tk.due || next <= tk.due));
      })
      .sort(taskSorter(vd));
    if (homeless.length){
      const names = {};
      homeless.forEach(tk => { const c = S.categories.find(x => x.id === tk.cat); names[c ? c.label : 'Other'] = 1; });
      h += '<div class="homeless"><div class="homeless-h">'+
        '<b>'+homeless.length+' task'+(homeless.length !== 1 ? 's' : '')+' with nowhere to go</b>'+
        '<span>Nothing scheduled for '+esc(Object.keys(names).join(', '))+' between now and when '+
        (homeless.length === 1 ? 'this is' : 'these are')+' due. Tick them off here, or give them somewhere to live.</span></div>'+
        '<div class="tlist">'+homeless.map(tk => taskRow(tk, vd, true)).join('')+'</div>'+
        '<button class="linkish" data-newon="'+dk+'">Add a block for today</button></div>';
    }

    if (reviewOpen) h += dayReviewHTML(vd);

    h += '<div class="dayadd"><button data-newon="'+dk+'">+ New event</button>'+
      '<button class="ai-btn" data-aiopen>✦ Ask your AI</button>'+
      (reviewOpen ? '' : '<button data-review>How today went</button>')+'</div>';
    return h;
  }

  /* ---------- habits ---------- */
  function habitList(){
    const out = (S.habits || []).map(x => ({ id:x.id, l:x.label, c:x.cat||'health', target:(x.target&&x.target>1)?x.target:0, own:true }));
    (S.goals || []).forEach(g => (g.steps||[]).forEach(st => {
      if (st.freq === 'daily') out.push({ id:st.id, l:st.label, c:g.cat||'work', target:0, goal:true });
    }));
    return out;
  }

  /* ---- routines ----
     A habit inside a routine is not also a loose chip. It happens when its
     routine happens, which is the whole reason for putting it in one: you do
     not decide separately when to take your vitamins, you take them as part of
     the morning. On a day its routine does not run, it does not come up at all
     and does not count against the day. */
  const routinesAll = () => (S.routines || []);
  const runsOn = (r, D) => !(r.weekdays || []).length || r.weekdays.indexOf(D.getDay()) !== -1;
  const routinesOnDate = D => routinesAll().filter(r => r.time && runsOn(r, D)).slice()
    .sort((a, b) => mins(a.time) - mins(b.time));
  const routineOf = habitId => routinesAll().find(r => (r.habits || []).indexOf(habitId) !== -1) || null;
  const looseHabits = () => habitList().filter(h => !routineOf(h.id));
  function routineHabits(r){
    const all = habitList();
    return (r.habits || []).map(id => all.find(h => h.id === id)).filter(Boolean);
  }
  // Everything that counts toward today: loose habits, plus the members of any
  // routine actually running today.
  function activeHabits(D){
    const out = looseHabits();
    routinesAll().forEach(r => { if (runsOn(r, D) && r.time) routineHabits(r).forEach(h => out.push(h)); });
    return out;
  }
  function routineProgress(r, D){
    const hs = routineHabits(r), dk = dayKey(D);
    return { done: hs.filter(h => isDone(h.id, dk, h.target)).length, total: hs.length };
  }
  function routineBlocksOnDate(D){
    const dk = dayKey(D);
    return routinesOnDate(D).map(r => ({
      id: r.id, uid: 'routine:' + r.id + '@' + dk,
      t: r.name, n: '', c: r.cat || (routineHabits(r)[0] || {}).c || (S.categories[0] || {}).id,
      allDay: false, s: r.time, e: fmtM(Math.min(24 * 60 - 1, mins(r.time) + 30)),
      routine: r
    }));
  }
  function chipsHTML(now){
    const dk = dayKey(now);
    let h = '<div class="chips">';
    looseHabits().forEach(d => {
      const col = catColor(d.c);
      const tint = 'background:'+col+'22;border-color:'+col+'55';
      if (d.target){
        const v = compVal(d.id, dk) || 0;
        let p=''; for (let i=0;i<d.target;i++) p += '<span class="pip'+(i<v?' on':'')+'" style="'+(i<v?'background:'+col+';border-color:'+col:'')+'"></span>';
        h += '<button class="chip'+(v>=d.target?' on':'')+(justDone===d.id?' just':'')+'" style="'+(v>=d.target?tint:'')+'" data-pip="'+d.id+':'+d.target+'"><span class="cl">'+esc(d.l)+'</span><span class="pips">'+p+'</span></button>';
      } else {
        const on = isDone(d.id, dk);
        h += '<button class="chip'+(on?' on':'')+(justDone===d.id?' just':'')+'" style="'+(on?tint:'')+'" data-done="'+d.id+'"><span class="cl">'+esc(d.l)+'</span>'+
          '<span class="mark" style="'+(on?'background:'+col+';border-color:'+col:'')+'"></span></button>';
      }
    });
    h += '</div>';
    return h;
  }
  /* ==========================================================================
     Notes — a board for things worth keeping.
     Park is the scratchpad for today; this is the shelf. A note is either prose
     or a tickable list, and its checkboxes are its own business: they never
     become tasks, because a packing list is not six things on your day.
     ========================================================================== */
  let noteEdit = null;        // the note being edited, or null
  let noteSearch = '';
  let notesArchived = false;  // showing the archive rather than the board

  // Named colours rather than hex, so each one can be a pale wash on stone and
  // a deep tint in the dark without storing two values or computing a blend.
  const NOTE_COLORS = ['none','rose','amber','sage','sky','lilac','stone'];

  const notesAll = () => (S.notes || []);
  function noteMatches(n, q){
    if (!q) return true;
    const hay = (n.title + ' ' + n.body + ' ' + (n.items || []).map(i => i.text).join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function newNote(kind){
    const n = {
      id: 'nt_' + uid8(), kind: kind === 'list' ? 'list' : 'text',
      title: '', body: '', items: [], images: [], color: 'none', cat: null,
      pinned: false, archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    S.notes = notesAll().concat([n]);
    return n;
  }
  const findNote = id => notesAll().find(n => n.id === id);
  const noteIsBlank = n => !n.title && !n.body && !(n.items || []).length && !(n.images || []).length;
  function touchNote(n){ n.updatedAt = new Date().toISOString(); }

  /* ---- photos on notes ----
     The only part of Athena that does not live in the JSON blob, because it
     cannot: the blob is read and rewritten on every change, and a few phone
     photos would make that tens of megabytes a tick. Files go to Supabase
     Storage under <user>/<note>/<file>.jpg and the note keeps only the path.

     Everything is shrunk in the browser first. A 4MB photo lands at a few
     hundred KB, which is the difference between a note board that opens
     instantly on mobile data and one that does not. */
  const IMG_MAX = 1600;          // longest edge, plenty for a note
  const IMG_QUALITY = 0.82;
  const IMG_PER_NOTE = 6;
  let imgBusy = '';              // message while a photo is being added
  // Why the last photo failed. An alert is useless for this: it vanishes, it
  // cannot be screenshotted on a phone, and by the time anyone asks "what did
  // it say" the answer is gone. This sits on the screen until it is fixed.
  let imgError = '';
  const imgUrls = {};            // path -> { url, exp } signed-URL cache

  // Turn whatever came back into something a person can act on, and keep the
  // raw wording too, because that is what actually identifies the fault.
  function photoProblem(e){
    const msg = (e && (e.message || e.error || e.statusCode)) ? String(e.message || e.error || e.statusCode) : String(e || 'unknown');
    let plain = '';
    if (/bucket not found|does not exist/i.test(msg))
      plain = 'The photo store has not been created in Supabase yet. The storage part of the setup SQL did not take.';
    else if (/row-level security|violates|not authorized|403|unauthorized/i.test(msg))
      plain = 'Supabase refused the upload. The bucket exists but its three permission rules are missing or wrong.';
    else if (/unreadable/i.test(msg))
      plain = 'This device could not read that image file.';
    else if (/encode/i.test(msg))
      plain = 'This device could not shrink that image. It may be very large.';
    else if (/network|fetch|load failed/i.test(msg))
      plain = 'The upload could not reach Supabase. Check the connection and try again.';
    return { plain: plain, raw: msg };
  }

  function shrinkImage(file){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, IMG_MAX / Math.max(im.width, im.height));
        const w = Math.max(1, Math.round(im.width * scale));
        const h = Math.max(1, Math.round(im.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(im, 0, 0, w, h);
        cv.toBlob(b => b ? resolve({ blob: b, w: w, h: h }) : reject(new Error('could not encode')),
          'image/jpeg', IMG_QUALITY);
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      im.src = url;
    });
  }

  // Takes a list, because a drop can carry several at once and doing them one
  // at a time with a count is friendlier than a silent pause.
  async function addNoteImages(files, note){
    imgError = '';
    const all = Array.prototype.slice.call(files || []);
    if (!all.length) return;
    // Some phones hand back a file with no MIME type at all. Trusting the type
    // alone means the file is silently dropped and nothing whatever happens,
    // which is the worst kind of failure: there is nothing to report.
    const list = all.filter(f => /^image\//.test(f.type || '') ||
      /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(f.name || ''));
    if (!list.length){
      imgError = 'That did not look like an image. [' +
        all.map(f => (f.name || 'no name') + ', ' + (f.type || 'no type') + ', ' + Math.round((f.size || 0) / 1024) + 'KB').join(' | ') +
        '] · v' + BUILD;
      render(); return;
    }
    if (!cloud || !session){ imgError = 'Not signed in on this device, so there is nowhere safe to put a photo.'; render(); return; }
    const n = note || noteEdit;
    if (!n) return;
    const room = IMG_PER_NOTE - (n.images || []).length;
    if (room <= 0){ imgError = 'That is already ' + IMG_PER_NOTE + ' photos, which is plenty for one note.'; render(); return; }
    const take = list.slice(0, room);
    for (let i = 0; i < take.length; i++){
      imgBusy = take.length > 1 ? ('Adding ' + (i + 1) + ' of ' + take.length + '…') : 'Adding photo…';
      render();
      try {
        const f = take[i];
        const shrunk = await shrinkImage(f);
        const id = 'im_' + uid8();
        const path = session.user.id + '/' + n.id + '/' + id + '.jpg';
        const { error } = await sb.storage.from('note-images')
          .upload(path, shrunk.blob, { contentType: 'image/jpeg', upsert: false });
        if (error) throw error;
        n.images = (n.images || []).concat([{ id: id, path: path, w: shrunk.w, h: shrunk.h }]);
        touchNote(n); save();
      } catch (e){
        const p = photoProblem(e);
        const f = take[i];
        // Everything needed to work out what went wrong, in one screenshottable
        // line: the plain reason, the exact wording, and what was being sent.
        imgError = (p.plain ? p.plain + ' ' : '') + '[' + p.raw + '] · ' +
          Math.round((f.size || 0) / 1024) + 'KB ' + (f.type || 'unknown type') + ' · v' + BUILD;
        if (typeof console !== 'undefined') console.error('Athena photo failed:', e, f && f.type, f && f.size);
        break;                       // one clear failure beats six identical ones
      }
    }
    if (!imgError && list.length > room) imgError = 'Added ' + room + '. A note holds ' + IMG_PER_NOTE + ' photos.';
    imgBusy = ''; render();
  }
  const addNoteImage = file => addNoteImages([file]);

  async function removeNoteImage(n, imgId){
    const img = (n.images || []).find(x => x.id === imgId);
    if (!img) return;
    n.images = (n.images || []).filter(x => x.id !== imgId);
    touchNote(n); save(); render();
    // The file goes too. Orphans nobody can see still fill the quota.
    try { if (cloud && session) await sb.storage.from('note-images').remove([img.path]); } catch(_){}
  }

  async function signedUrl(path){
    const hit = imgUrls[path];
    if (hit && hit.exp > Date.now()) return hit.url;
    if (!cloud || !session) return null;
    try {
      const { data, error } = await sb.storage.from('note-images').createSignedUrl(path, 3600);
      if (error || !data) return null;
      imgUrls[path] = { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 };
      return data.signedUrl;
    } catch(_){ return null; }
  }

  // Images are fetched after the page is drawn, so a signed URL round trip never
  // holds up a render. Each <img> asks for its own and fills itself in.
  async function hydrateImages(){
    const els = app.querySelectorAll('img[data-imgpath]:not([data-loaded])');
    for (let i = 0; i < els.length; i++){
      const el = els[i];
      el.setAttribute('data-loaded', '1');
      const url = await signedUrl(el.dataset.imgpath);
      if (url) el.src = url;
      else el.replaceWith(Object.assign(document.createElement('div'), { className: 'note-img missing', textContent: 'Photo unavailable' }));
    }
  }

  /* ---- arriving from an Android share ----
     The service worker has parked whatever was shared and bounced us back here
     with a flag. Turn it into a note, then empty the cache, so a photo shared
     from the gallery lands in Athena the way it would in any other app. iOS
     cannot do this: only an App Store app can appear in its share sheet. */
  async function consumeShare(){
    if (!/[?&]shared=1/.test(location.search)) return;
    // Clear the flag first, so a refresh cannot import the same thing twice.
    try { history.replaceState(null, '', location.pathname); } catch(_){}
    if (!window.caches) return;
    let meta = null;
    const files = [];
    try {
      const cache = await caches.open('athena-share');
      const metaRes = await cache.match('./__share/meta');
      if (!metaRes) return;
      meta = await metaRes.json();
      for (let i = 0; i < (meta.files || []).length; i++){
        const key = meta.files[i];
        const r = await cache.match(key);
        if (r){
          const b = await r.blob();
          files.push(new File([b], 'shared-' + i + '.jpg', { type: b.type || 'image/jpeg' }));
        }
        await cache.delete(key);
      }
      await cache.delete('./__share/meta');
    } catch(_){ return; }
    if (!meta) return;

    const text = [meta.text, meta.url].filter(Boolean).join('\n').trim();
    const given = (meta.title || '').trim();
    const lines = text ? text.split('\n') : [];
    const title = given || (lines.length ? lines[0].slice(0, 140) : (files.length ? 'Shared photo' : ''));
    if (!title && !text && !files.length) return;

    // When the title had to be borrowed from the first line, that line is now
    // the title, and repeating it underneath just looks like a mistake.
    const body = (!given && lines.length && lines[0].slice(0, 140) === title)
      ? lines.slice(1).join('\n').trim()
      : text;

    const n = newNote('text');
    n.title = title.slice(0, 140);
    n.body = body.slice(0, 8000);
    view = 'notes'; noteEdit = n;
    save(); render();
    if (files.length) await addNoteImages(files, n);
  }

  // The one line that best names this note, for when it becomes something else.
  const noteHeadline = n =>
    (n.title || String(n.body || '').split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 140);

  /* What this note would become as tasks. A checklist gives one task per item
     still outstanding, which is the whole point of ticking half a list and
     wanting the rest on your actual day. A prose note gives one task named
     after it. Ticked items are left behind: they are already done. */
  function noteToTasks(n){
    if (n.kind === 'list')
      return (n.items || []).filter(i => !i.done && i.text.trim()).map(i => i.text.trim().slice(0, 140));
    const head = noteHeadline(n);
    return head ? [head] : [];
  }

  function noteCardHTML(n){
    const done = (n.items || []).filter(i => i.done).length;
    const cat = n.cat ? S.categories.find(c => c.id === n.cat) : null;
    const imgs = n.images || [];
    let h = '<div class="note c-'+esc(n.color || 'none')+'" data-noteopen="'+n.id+'">';
    h += '<button class="note-pin'+(n.pinned?' on':'')+'" data-notepin="'+n.id+'" '+
      'aria-label="'+(n.pinned?'Unpin':'Pin to top')+'">'+PIN+'</button>';
    if (imgs.length){
      // One photo leads the card; the rest are counted rather than stacked, so a
      // note with six holiday shots is still a card and not a scroll.
      h += '<div class="note-imgwrap"><img class="note-img" data-imgpath="'+esc(imgs[0].path)+'" alt="" '+
        (imgs[0].w ? 'style="aspect-ratio:'+imgs[0].w+'/'+imgs[0].h+'"' : '')+'>'+
        (imgs.length > 1 ? '<span class="note-imgn">+'+(imgs.length - 1)+'</span>' : '')+'</div>';
    }
    if (n.title) h += '<div class="note-t">'+esc(n.title)+'</div>';
    if (n.kind === 'list'){
      const show = (n.items || []).slice(0, 6);
      h += '<ul class="note-list">' + show.map(i =>
        '<li class="'+(i.done?'done':'')+'"><button data-noteitem="'+n.id+':'+i.id+'" aria-label="'+
        (i.done?'Untick':'Tick')+' '+esc(i.text)+'"><span class="mark">'+TICK+'</span></button>'+
        '<span>'+esc(i.text)+'</span></li>').join('') + '</ul>';
      if ((n.items || []).length > 6) h += '<div class="note-more">+'+((n.items||[]).length - 6)+' more</div>';
      if ((n.items || []).length) h += '<div class="note-meta">'+done+' of '+n.items.length+' done</div>';
    } else if (n.body){
      h += '<div class="note-b">'+esc(n.body)+'</div>';
    }
    if (!n.title && !n.body && !(n.items || []).length && !imgs.length) h += '<div class="note-b empty">Empty note</div>';
    if (cat) h += '<div class="note-cat"><b style="background:'+catColor(cat.id)+'"></b>'+esc(cat.label)+'</div>';
    h += '</div>';
    return h;
  }

  function notesView(now){
    const q = noteSearch.trim().toLowerCase();
    const live = notesAll().filter(n => !!n.archived === notesArchived);
    const shown = live.filter(n => noteMatches(n, q));
    const pinned = shown.filter(n => n.pinned);
    const rest = shown.filter(n => !n.pinned);
    const archivedCount = notesAll().filter(n => n.archived).length;

    let h = '';
    if (!notesArchived){
      h += '<div class="notenew">'+
        '<input id="nt_quick" type="text" placeholder="Take a note…" autocomplete="off">'+
        '<button data-notequick>Add</button>'+
        '<button class="ghost" data-notenew="list" aria-label="New checklist">+ List</button>'+
        '<button class="ghost" data-notephoto aria-label="New note with a photo">+ Photo</button>'+
        '</div>';
    }
    if (notesAll().length >= 5 || q)
      h += '<div class="notesearch"><input id="nt_search" type="search" placeholder="Search notes…" '+
        'autocomplete="off" value="'+esc(noteSearch)+'"></div>';

    if (!shown.length){
      h += '<p class="park-empty">' + (q
        ? 'Nothing matches “'+esc(noteSearch)+'”.'
        : notesArchived
          ? 'Nothing archived yet.'
          : 'No notes yet. Anything worth keeping: a list, a half-formed idea, the wifi password.') + '</p>';
    }
    if (pinned.length){
      h += '<h2>Pinned <span class="tcount">'+pinned.length+'</span></h2>';
      h += '<div class="noteboard">'+pinned.map(noteCardHTML).join('')+'</div>';
    }
    if (rest.length){
      if (pinned.length) h += '<h2>Everything else <span class="tcount">'+rest.length+'</span></h2>';
      h += '<div class="noteboard">'+rest.map(noteCardHTML).join('')+'</div>';
    }
    if (archivedCount || notesArchived){
      h += '<div class="dayadd" style="margin-top:18px"><button data-notearchiveview>'+
        (notesArchived ? 'Back to your notes' : 'Archived ('+archivedCount+')')+'</button></div>';
    }
    return h;
  }

  function noteEditorHTML(){
    const n = noteEdit;
    const CATOPTS = '<option value="">No category</option>' + S.categories.map(c =>
      "<option value='"+c.id+"'"+(c.id===n.cat?' selected':'')+">"+esc(c.label)+"</option>").join('');
    let h = '<div class="modal-back" data-notecancel></div><div class="modal note-modal c-'+esc(n.color||'none')+'">';
    h += '<div class="modal-h">'+(n.kind === 'list' ? 'Checklist' : 'Note')+'</div>';
    h += '<label class="fld"><span>Title</span><input id="ne_title" type="text" value="'+esc(n.title)+'" autocomplete="off" placeholder="Optional"></label>';
    if (n.kind === 'list'){
      h += '<div class="fld"><span>Items</span><div class="ne-items">';
      (n.items || []).forEach(i => {
        h += '<div class="ne-item">'+
          '<button class="ne-tick'+(i.done?' on':'')+'" data-noteitem="'+n.id+':'+i.id+'" aria-label="Tick">'+TICK+'</button>'+
          '<input type="text" data-noteitemtext="'+i.id+'" value="'+esc(i.text)+'" autocomplete="off">'+
          '<button class="del" data-noteitemdel="'+i.id+'" aria-label="Remove">×</button></div>';
      });
      h += '</div><div class="ne-add"><input id="ne_newitem" type="text" placeholder="Add an item" autocomplete="off">'+
        '<button class="ghost" data-noteadditem>Add</button></div></div>';
    } else {
      h += '<label class="fld"><span>Note</span><textarea id="ne_body" rows="7" placeholder="Anything worth keeping">'+esc(n.body)+'</textarea></label>';
    }
    h += '<div class="fld"><span>Photos</span><div class="ne-imgs">'+
      (n.images || []).map(im =>
        '<div class="ne-img"><img data-imgpath="'+esc(im.path)+'" alt="">'+
        '<button class="del" data-noteimgdel="'+n.id+':'+im.id+'" aria-label="Remove photo">×</button></div>').join('')+
      ((n.images || []).length < IMG_PER_NOTE
        ? '<label class="ne-imgadd'+(imgBusy?' busy':'')+'">'+(imgBusy || '+ Photo')+
          '<input id="ne_file" type="file" accept="image/*" hidden></label>'
        : '')+
      '</div>'+
      (imgError ? '<div class="errdetail"><b>Photo did not go</b><span>'+esc(imgError)+'</span></div>' : '')+
      (!cloud || !session
        ? '<small class="gform-hint">Photos need an account, so they are stored safely and reach your other devices.</small>'
        : '<small class="gform-hint">On a computer you can also paste a picture straight in, or drag one onto this note.</small>')+
      '</div>';
    h += '<div class="fld"><span>Colour</span><div class="ne-colors">'+NOTE_COLORS.map(c =>
      '<button class="ne-color c-'+c+(c===(n.color||'none')?' on':'')+'" data-notecolor="'+c+'" aria-label="'+c+'"></button>').join('')+'</div></div>';
    h += '<label class="fld"><span>Category</span><select id="ne_cat">'+CATOPTS+'</select></label>';
    h += '<div class="ne-row">'+
      '<button class="ghost" data-notepin="'+n.id+'">'+(n.pinned ? 'Unpin' : 'Pin to top')+'</button>'+
      '<button class="ghost" data-notearchive="'+n.id+'">'+(n.archived ? 'Unarchive' : 'Archive')+'</button>'+
      (n.kind === 'text'
        ? '<button class="ghost" data-notetolist="'+n.id+'">Turn into a checklist</button>'
        : '<button class="ghost" data-notetotext="'+n.id+'">Turn into a note</button>')+
      '</div>';
    // The bridge from the shelf to the day. Nothing here touches the note: a
    // note you acted on is often still worth keeping, and quietly consuming it
    // would be a nasty surprise.
    const willMake = noteToTasks(n).length;
    if (willMake || noteHeadline(n))
      h += '<div class="ne-row make">'+
        (willMake ? '<button class="ghost" data-notemaketask="'+n.id+'">Make '+
          (willMake === 1 ? 'a task' : willMake + ' tasks')+'</button>' : '')+
        (noteHeadline(n) ? '<button class="ghost" data-notemakeblock="'+n.id+'">Make a block</button>' : '')+
        '</div>';
    h += '<div class="modal-actions"><button class="del" data-notedelete="'+n.id+'">Delete</button>'+
      '<span style="flex:1"></span><button class="ghost" data-notecancel>Cancel</button>'+
      '<button class="go" data-notesave>Save</button></div></div>';
    return h;
  }

  // Read the editor's fields back into the note. Called before anything that
  // re-renders the modal, so typing is never lost to a colour tap.
  function noteSync(){
    if (!noteEdit) return;
    const g = id => document.getElementById(id);
    if (g('ne_title')) noteEdit.title = g('ne_title').value.slice(0, 140);
    if (g('ne_body'))  noteEdit.body  = g('ne_body').value.slice(0, 8000);
    if (g('ne_cat'))   noteEdit.cat   = g('ne_cat').value || null;
    (noteEdit.items || []).forEach(i => {
      const el = document.querySelector('[data-noteitemtext="'+i.id+'"]');
      if (el) i.text = el.value.slice(0, 200);
    });
  }

  const RD = ['S','M','T','W','T','F','S'];

  function routineDays(r){
    const wd = (r.weekdays || []).slice().sort();
    if (!wd.length || wd.length === 7) return 'Every day';
    if (wd.length === 5 && wd.indexOf(0) === -1 && wd.indexOf(6) === -1) return 'Weekdays';
    if (wd.length === 2 && wd.indexOf(0) !== -1 && wd.indexOf(6) !== -1) return 'Weekends';
    return wd.map(d => SD[d]).join(' & ');
  }

  function routinesView(now){
    const rs = routinesAll();
    const spare = habitList().filter(h => h.own && !routineOf(h.id));
    let h = '<p class="slack">A routine is a handful of habits you do together, at a time. '+
      'Its habits turn up in your day inside the routine, and nowhere else, so you are not deciding twice when to take your vitamins.</p>';

    if (!rs.length)
      h += '<p class="park-empty">No routines yet. A morning one is the usual place to start.</p>';

    rs.forEach(r => {
      const hs = routineHabits(r);
      const p = routineProgress(r, now);
      const col = catColor(r.cat || (hs[0] || {}).c || (S.categories[0] || {}).id);
      h += '<div class="rcard" style="--rc:'+col+'">';
      h += '<div class="rhead"><span class="rbar"></span>'+
        '<div class="rname"><input type="text" data-rname="'+r.id+'" value="'+esc(r.name)+'" autocomplete="off">'+
        '<small>'+(hs.length ? p.done+' of '+p.total+' done today' : 'No habits in it yet')+'</small></div>'+
        '<button class="del" data-delroutine="'+r.id+'" aria-label="Remove routine">×</button></div>';
      h += '<div class="rwhen">'+
        '<label><span>At</span><input type="time" data-rtime="'+r.id+'" value="'+esc(r.time || '07:00')+'"></label>'+
        '<span class="rdays">'+RD.map((d, i) =>
          '<button class="'+(runsOn(r, { getDay: () => i }) ? 'on' : '')+'" data-rwd="'+r.id+':'+i+'">'+d+'</button>').join('')+
        '</span></div>';
      h += '<div class="rlist">' + (hs.length ? hs.map((hb, i) =>
        '<div class="rrow"><span class="cd" style="background:'+catColor(hb.c)+'"></span>'+
        '<span class="rrl">'+esc(hb.l)+'</span>'+
        '<button class="rmove" data-rup="'+r.id+':'+hb.id+'"'+(i === 0 ? ' disabled' : '')+' aria-label="Move up">↑</button>'+
        '<button class="rmove" data-rdown="'+r.id+':'+hb.id+'"'+(i === hs.length-1 ? ' disabled' : '')+' aria-label="Move down">↓</button>'+
        '<button class="del" data-rout="'+r.id+':'+hb.id+'" aria-label="Take out of the routine">×</button></div>').join('')
        : '<p class="park-empty" style="margin:2px 0 0">Add a habit below, or make a new one.</p>') + '</div>';
      h += '<div class="radd">'+
        '<input type="text" id="rnew_'+r.id+'" placeholder="New habit for this routine" autocomplete="off">'+
        '<button class="ghost" data-raddnew="'+r.id+'">Add</button></div>';
      if (spare.length)
        h += '<div class="radd"><select id="rpick_'+r.id+'"><option value="">Move an existing habit in…</option>'+
          spare.map(s => '<option value="'+s.id+'">'+esc(s.l)+'</option>').join('')+'</select>'+
          '<button class="ghost" data-raddexisting="'+r.id+'">Move</button></div>';
      h += '</div>';
    });

    h += '<h2>Add a routine</h2><div class="gform">'+
      '<input id="ro_name" type="text" placeholder="Morning routine" autocomplete="off">'+
      '<div class="frow"><input id="ro_time" type="time" value="07:00">'+
      '<select id="ro_days"><option value="all">Every day</option><option value="wd" selected>Weekdays</option><option value="we">Weekends</option></select></div>'+
      '<button class="go" data-addroutine>Add routine</button>'+
      '<small class="gform-hint">You can change the days one at a time once it exists.</small></div>';
    return h;
  }

  function habitsView(now){
    const today = dayKey(now);
    const monday = parseDay(weekKey(now));
    const start = new Date(monday); start.setDate(monday.getDate() - 21);

    let h = '<h2>Every day</h2>' + chipsHTML(now);
    h += '<h2>The last four weeks</h2>';
    h += '<div class="habhead"><div class="hdow">' + ['M','T','W','T','F','S','S'].map(x=>'<span>'+x+'</span>').join('') + '</div></div>';

    // The history shows every habit, routine members included: their streaks are
    // the thing worth looking at, even though they are ticked inside a routine.
    habitList().forEach(d => {
      const col = catColor(d.c);
      const inR = routineOf(d.id);
      let cells = '', count = 0, elapsed = 0;
      for (let i = 0; i < 28; i++){
        const dd = new Date(start); dd.setDate(start.getDate() + i);
        const k = dayKey(dd);
        const fut = k > today, isTd = k === today;
        const on = !fut && isDone(d.id, k, d.target);
        if (!fut){ elapsed++; if (on) count++; }
        cells += '<i class="'+(fut?'fut':'')+(isTd?' td':'')+'" style="'+(on?'background:'+col+';border-color:'+col:'')+'"></i>';
      }
      let streak = 0;
      for (let i = 0; i < 200; i++){
        const dd = new Date(now); dd.setDate(now.getDate() - i);
        if (isDone(d.id, dayKey(dd), d.target)) streak++;
        else if (i > 0) break;
      }
      h += '<div class="hab"><div class="hl"><b>'+esc(d.l)+'</b>'+
        '<small>'+count+' of '+elapsed+' days'+(streak>1?' · <em>'+streak+' day run</em>':'')+
        (inR ? ' · <em class="inroutine">'+esc(inR.name)+'</em>' : '')+'</small></div>'+
        '<div class="hgrid">'+cells+'</div>'+
        (d.own ? '<button class="del" data-delhabit="'+d.id+'" aria-label="Remove habit">×</button>' : '')+
        '</div>';
    });

    const CATOPTS = S.categories.map(c => "<option value='"+c.id+"'>"+esc(c.label)+"</option>").join('');
    h += '<h2>Add a habit</h2><div class="gform">'+
      '<input id="hl" type="text" placeholder="Something you want to do every day" autocomplete="off">'+
      '<div class="frow">'+
        '<select id="hc">'+CATOPTS+'</select>'+
        '<select id="hn"><option value="1" selected>Once a day</option><option value="2">Twice a day</option><option value="3">3 times</option><option value="4">4 times</option><option value="5">5 times</option><option value="6">6 times</option></select>'+
      '</div>'+
      '<button class="go" data-addhabit>Add habit</button></div>';
    h += '<p class="slack" style="padding-top:14px">History starts from the first day you tick something here. Days you did not open Athena stay blank.</p>';
    return h;
  }

  /* ---------- goals ---------- */
  const stepDone = (st, now) => {
    if (st.freq === 'daily') return isDone(st.id, dayKey(now));
    if (st.freq === 'weekly') return isDone('w:'+st.id, weekKey(now));
    return isDone('m:'+st.id, monKey(now));
  };
  function goalsView(now){
    const today = dayKey(now);
    const CATOPTS = S.categories.map(c => "<option value='"+c.id+"'>"+esc(c.label)+"</option>").join('');
    const DAYOPTS = [1,2,3,4,5,6,0].map(d => "<option value='"+d+"'>"+SD[d]+"</option>").join('');
    const freqText = st => st.freq === 'daily' ? 'Every day'
      : st.freq === 'weekly' ? (st.time != null ? SD[st.day == null ? 1 : st.day] + ' ' + clockOf(st.time) : 'Weekly')
      : 'Monthly';
    const nice = d => { const x = parseDay(d); return x.getDate()+' '+SHORT[x.getMonth()]+' '+x.getFullYear(); };

    let h = '<h2>What you are building</h2>';
    if (!(S.goals||[]).length){
      h += '<p class="park-empty">Nothing set yet. Name one thing you are building toward, give it a date, then break it into small repeatable steps. Daily steps join your everyday ticks automatically.</p>';
    }
    (S.goals||[]).forEach(g => {
      const steps = g.steps || [];
      const done = steps.filter(st => stepDone(st, now)).length;
      const col = catColor(g.cat);
      let sub = 'No date set';
      if (g.by){
        const left = daysBetween(today, g.by);
        sub = left > 1 ? left + ' days to go · ' + nice(g.by)
            : left === 1 ? 'Tomorrow · ' + nice(g.by)
            : left === 0 ? 'Today is the day'
            : 'Date passed · ' + nice(g.by);
      }
      h += '<div class="goal"><button class="ghead" data-goal="'+g.id+'">'+
        '<span class="swatch" style="background:'+col+'"></span>'+
        '<span class="gl"><b>'+esc(g.title)+'</b><small'+(g.by && g.by < today ? ' class="late"' : '')+'>'+esc(sub)+'</small></span>'+
        '<span class="bar"><i style="width:'+(steps.length ? done/steps.length*100 : 0)+'%;background:'+col+'"></i></span>'+
        '<span class="val">'+done+' of '+steps.length+'</span></button>';
      if (openGoal === g.id){
        h += '<div class="gbody">';
        if (!steps.length) h += '<p class="park-empty" style="padding:8px 2px 4px">No steps yet. What will you do daily, weekly or monthly to get there?</p>';
        steps.forEach(st => {
          const on = stepDone(st, now);
          h += '<div class="grow2"><button class="mini'+(on?' on':'')+'" data-step="'+g.id+':'+st.id+'">'+
            '<span class="mark" style="'+(on?'background:'+col+';border-color:'+col:'')+'"></span>'+
            '<span>'+esc(st.label)+'</span><span class="day">'+esc(freqText(st))+'</span></button>'+
            '<button class="del" data-delstep="'+g.id+':'+st.id+'" aria-label="Remove step">×</button></div>';
        });
        h += '<div class="gform">'+
          '<input id="sl_'+g.id+'" type="text" placeholder="A step you will repeat" autocomplete="off">'+
          '<div class="frow">'+
            '<select id="sf_'+g.id+'"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option></select>'+
            '<select id="sday_'+g.id+'">'+DAYOPTS+'</select>'+
            '<input id="stime_'+g.id+'" type="time" value="17:00">'+
          '</div>'+
          '<button class="go" data-addstep="'+g.id+'">Add step</button>'+
          '<small class="gform-hint">Day and time apply to weekly steps, which then appear on your calendar.</small></div>';
        h += '<button class="del wide" data-delgoal="'+g.id+'">Remove this goal</button>';
        h += '</div>';
      }
    });
    h += '<h2>New goal</h2><div class="gform">'+
      '<input id="gt" type="text" placeholder="What are you building toward?" autocomplete="off">'+
      '<div class="frow"><input id="gb" type="date"><select id="gc">'+CATOPTS+'</select></div>'+
      '<button class="go" data-addgoal>Add goal</button></div>';
    h += '<p class="slack" style="padding-top:16px">Daily steps become everyday tick-offs. Weekly steps show up in your calendar on the day and time you pick. Monthly steps are tracked here.</p>';
    return h;
  }

  /* ---------- parked thoughts ---------- */
  /* ---------- tasks view ---------- */
  let showDone = false;

  function repeatLabel(rep){ return rep ? (rep.freq === 'daily' ? 'Daily' : rep.freq === 'monthly' ? 'Monthly' : 'Weekly') : ''; }
  function dueLabel(due, d, type){
    const on = type === 'on';
    const diff = daysBetween(dayKey(d), due);
    if (diff < 0) return { text: Math.abs(diff) + (Math.abs(diff) === 1 ? ' day over' : ' days over'), late: true };
    if (diff === 0) return { text: on ? 'Today' : 'Due today', soon: true };
    if (diff === 1) return { text: on ? 'Tomorrow' : 'By tomorrow' };
    const x = parseDay(due);
    return { text: (on ? 'On ' : 'By ') + x.getDate() + ' ' + SHORT[x.getMonth()] };
  }

  function taskRow(tk, d, compact){
    const done = taskDone(tk, d);
    const col = catColor(tk.cat);
    const bits = [];
    if (tk.priority === 'high') bits.push('<i class="prio-high">High</i>');
    if (!compact) bits.push('<i class="tcat"><b style="background:'+col+'"></b>'+esc(catOf(tk.cat).label)+'</i>');
    if (tk.due){ const dl = dueLabel(tk.due, d, tk.dateType); bits.push('<i class="'+(dl.late?'due-late':dl.soon?'due-soon':'')+'">'+esc(dl.text)+'</i>'); }
    if (tk.at) bits.push('<i class="tat">'+clockOf(tk.at)+'</i>');
    // Planned against actual, once there is an actual. This is the whole point
    // of tracking: the estimate stops being a guess nobody ever checks.
    const spent = spentEver('tk_' + tk.id);
    if (tk.mins && spent) bits.push('<i class="tspent'+(spent > tk.mins * 1.25 ? ' over' : '')+'">'+
      dur(spent)+' of '+dur(tk.mins)+'</i>');
    else if (spent) bits.push('<i class="tspent">'+dur(spent)+' spent</i>');
    else if (tk.mins) bits.push('<i class="tmins">'+dur(tk.mins)+'</i>');
    if (tk.repeat) bits.push('<i>'+repeatLabel(tk.repeat)+'</i>');
    // Inside a block a row can be dragged: to another block, or back to the
    // pile to unplace it. On the Tasks screen it is an ordinary row.
    return '<div class="trow'+(done?' done':'')+(justDone===tk.id?' just':'')+'"'+
      (compact ? ' draggable="true" data-dragtask="'+tk.id+'"' : '')+'>'+
      '<button class="tcheck" data-tasktoggle="'+tk.id+'|'+dayKey(d)+'" aria-label="Mark done">'+
        '<span class="mark" style="'+(done ? 'background:'+col+';border-color:'+col : 'border-color:'+col)+'">'+TICK+'</span></button>'+
      '<button class="tmain" data-taskedit="'+tk.id+'">'+
        '<span class="tt">'+esc(tk.title)+'</span>'+
        (bits.length ? '<span class="tmeta">'+bits.join('')+'</span>' : '')+
      '</button>'+
      (compact ? '' : '<button class="del" data-deltask="'+tk.id+'" aria-label="Remove task">×</button>')+
      '</div>';
  }

  function tasksView(now){
    const today = dayKey(now);
    const CATOPTS = S.categories.map(c => "<option value='"+c.id+"'>"+esc(c.label)+"</option>").join('');
    const open = openTasks(now).sort(taskSorter(now));

    // The single most useful thing to know about this screen, and the least
    // obvious: a task is not a to-do list entry that sits here waiting. It is
    // filed by category and turns up inside the matching block on the day.
    let h = '<div class="tasknote"><b>Tasks find their own way into your week.</b>'+
      '<span>Give a task a category and it appears inside the blocks that share it, ready to tick off, so you do it while you are already in that headspace. '+
      'Add how long it takes and Athena only puts it in a block with room for it. Nothing here needs scheduling by hand.</span></div>';

    // Tasks held back in the list. On a wide screen the To place panel shows
    // them; on a phone this is the only place they surface, so it carries the
    // same way to place them.
    const held = (S.tasks || []).filter(tk => tk.hold && placeable(tk));
    if (held.length)
      h += '<div class="heldnote"><span><b>'+held.length+' task'+(held.length !== 1 ? 's' : '')+' waiting to be placed.</b> '+
        'They stay out of your blocks until you place them.</span>'+
        '<button class="go" data-placeheld>Place them for me</button></div>';

    h += '<div class="gform taskadd">'+
      '<input id="tk_title" type="text" placeholder="What needs doing?" autocomplete="off">'+
      '<div class="frow">'+
        '<select id="tk_cat">'+CATOPTS+'</select>'+
        '<select id="tk_prio">'+PRIOS.map(p => "<option value='"+p[0]+"'"+(p[0]==='normal'?' selected':'')+">"+p[1]+"</option>").join('')+'</select>'+
      '</div>'+
      '<div class="frow">'+
        '<select id="tk_when">'+DATEKINDS.map(k => "<option value='"+k[0]+"'>"+k[1]+"</option>").join('')+'</select>'+
        '<input id="tk_due" type="date">'+
        '<input id="tk_at" type="time" aria-label="At a set time (optional)">'+
      '</div>'+
      '<div class="frow">'+
        '<select id="tk_rep"><option value="once" selected>One-off</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>'+
        '<select id="tk_mins">'+MINOPTS.map(o => "<option value='"+o[0]+"'>"+o[1]+"</option>").join('')+'</select>'+
      '</div>'+
      '<button class="go" data-addtask>Add task</button>'+
      '<small class="gform-hint">Only the name is required. "Due by" stays on your list until it is done; "Do on" only turns up that day. '+
      'Add a time and it stops queueing inside a block and takes its own place in the day, like an appointment.</small></div>';

    h += '<div class="dayadd" style="margin-top:14px"><button class="ai-btn" data-aiopen>✦ Dump a list with your AI</button></div>';

    const groups = [
      ['Overdue',   open.filter(t => t.due && t.due < today)],
      ['Today',     open.filter(t => t.due === today)],
      ['Coming up', open.filter(t => t.due && t.due > today)],
      ['Repeating', open.filter(t => !t.due && t.repeat)],
      ['Anytime',   open.filter(t => !t.due && !t.repeat)]
    ];
    const any = groups.some(g => g[1].length);
    if (!any){
      h += '<p class="park-empty">No tasks yet. Dump anything on your mind above. A name is enough, and it\'ll show up in the block that matches its category.</p>';
    }
    groups.forEach(g => {
      if (!g[1].length) return;
      h += '<h2>'+g[0]+' <span class="tcount">'+g[1].length+'</span></h2>';
      h += '<div class="tlist">' + g[1].map(tk => taskRow(tk, now)).join('') + '</div>';
    });

    const doneList = (S.tasks || []).filter(tk => taskDone(tk, now));
    if (doneList.length){
      h += '<h2><button class="linkish" data-toggledone>'+(showDone ? 'Hide' : 'Show')+' completed ('+doneList.length+')</button></h2>';
      if (showDone) h += '<div class="tlist">' + doneList.map(tk => taskRow(tk, now)).join('') + '</div>';
    }
    return h;
  }

  /* ---------- task editor ---------- */
  let taskEdit = null;
  function openTaskEditor(id){
    const tk = findTask(id); if (!tk) return;
    clearModalDrafts();
    // `at` matters here: the editor writes back every field it shows, so a time
    // left out of this copy comes back as blank and is saved over the real one.
    taskEdit = { id: tk.id, title: tk.title, note: tk.note || '', cat: tk.cat,
      priority: tk.priority || 'normal', due: tk.due || '',
      dateType: tk.dateType || 'by', mins: tk.mins || 0, at: tk.at || '',
      repeat: tk.repeat ? tk.repeat.freq : 'once' };
    render();
  }
  function taskEditorHTML(){
    const e = taskEdit;
    const CATOPTS = S.categories.map(c => "<option value='"+c.id+"'"+(c.id===e.cat?' selected':'')+">"+esc(c.label)+"</option>").join('');
    const REPS = [['once','One-off'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']];
    let h = '<div class="modal-back" data-closetask></div><div class="modal"><div class="modal-h">Edit task</div>';
    h += '<label class="fld"><span>Task</span><input id="te_title" type="text" value="'+esc(e.title)+'" autocomplete="off"></label>';
    h += '<label class="fld"><span>Note</span><input id="te_note" type="text" placeholder="Optional" value="'+esc(e.note)+'" autocomplete="off"></label>';
    h += '<label class="fld"><span>Category</span><select id="te_cat">'+CATOPTS+'</select></label>';
    h += '<div class="fld two">'+
      '<label><span>Priority</span><select id="te_prio">'+PRIOS.map(p=>"<option value='"+p[0]+"'"+(p[0]===e.priority?' selected':'')+">"+p[1]+"</option>").join('')+'</select></label>'+
      '<label><span>Repeat</span><select id="te_rep">'+REPS.map(r=>"<option value='"+r[0]+"'"+(r[0]===e.repeat?' selected':'')+">"+r[1]+"</option>").join('')+'</select></label></div>';
    h += '<div class="fld two">'+
      '<label><span>Date means</span><select id="te_when">'+DATEKINDS.map(k=>"<option value='"+k[0]+"'"+(k[0]===e.dateType?' selected':'')+">"+k[1]+"</option>").join('')+'</select></label>'+
      '<label><span>Date (optional)</span><input id="te_due" type="date" value="'+esc(e.due)+'"></label></div>';
    h += '<div class="fld two">'+
      '<label><span>At a set time</span><input id="te_at" type="time" value="'+esc(e.at || '')+'"></label>'+
      '<label><span>How long will it take?</span><select id="te_mins">'+MINOPTS.map(o=>"<option value='"+o[0]+"'"+(o[0]===e.mins?' selected':'')+">"+o[1]+"</option>").join('')+'</select></label></div>';
    h += '<small class="gform-hint">A time turns this into an appointment: it takes its own place in the day instead of waiting inside a block. Leave it blank and Athena decides when to offer it.</small>';
    h += '<div class="modal-actions"><button class="del" data-deltask="'+e.id+'">Delete</button>'+
      '<span style="flex:1"></span><button class="ghost" data-closetask>Cancel</button>'+
      '<button class="go" data-savetask>Save</button></div></div>';
    return h;
  }
  function commitTask(){
    const g = id => document.getElementById(id);
    const tk = findTask(taskEdit.id);
    if (!tk){ taskEdit = null; render(); return; }
    const title = (g('te_title') || {}).value || '';
    if (!title.trim()){ if (g('te_title')) g('te_title').focus(); return; }
    tk.title = title.trim().slice(0,140);
    tk.note = (((g('te_note') || {}).value) || '').trim().slice(0,200);
    tk.cat = (g('te_cat') || {}).value || tk.cat;
    tk.priority = (g('te_prio') || {}).value || 'normal';
    tk.due = (g('te_due') || {}).value || null;
    tk.dateType = (g('te_when') || {}).value || 'by';
    tk.mins = +((g('te_mins') || {}).value || 0) || null;
    const rep = (g('te_rep') || {}).value || 'once';
    tk.repeat = rep === 'once' ? null : { freq: rep, interval: 1 };
    tk.at = normaliseAt((g('te_at') || {}).value, tk);
    taskEdit = null; clearModalDrafts(); save(); render();
  }

  /* ==========================================================================
     Desktop panels.
     A phone gets one column, exactly as before. A wide screen puts the
     scratchpad beside the day instead of underneath it, and a big one moves the
     timer to the other side so the main column sits in the middle. Nothing here
     is a new place to look: it is the same scratchpad, just always to hand.
     ========================================================================== */
  const SIDE_ONE = 1000, SIDE_TWO = 1360;
  const panelsOn = () => typeof window !== 'undefined' && window.innerWidth >= SIDE_ONE;
  const twoPanels = () => typeof window !== 'undefined' && window.innerWidth >= SIDE_TWO;

  /* ---- the focus timer ----
     Deliberately does not know what you are working on. It is a clock, and a
     clock that is wrong about your intentions is worse than one that keeps
     quiet. The length is yours to pick, because twenty five minutes is somebody
     else's idea of a work session. */
  const TIMER_KEY = 'athena:timer';
  const TIMER_MINS = [5, 10, 15, 25, 45, 60];
  // target is the id of whatever the time is being spent on, or '' for nothing
  // in particular. Kept on the device with the rest of the timer, while the
  // minutes it produces go into the account.
  let timer = { mins: 25, endsAt: null, leftMs: 25 * 60000, done: 0, doneOn: '', target: '', startedAt: null };
  let timerTick = null;

  /* ---- what things actually took ----
     Every estimate in Athena is a guess until something checks it. Time is
     logged against the block or task it was spent on, so the guesses can be
     held up against the truth. */
  const spentAll = () => (S.spent || (S.spent = {}));
  function logTime(ref, m){
    if (!ref || m < 1) return;
    const dk = dayKey(new Date());
    const day = spentAll()[dk] || (spentAll()[dk] = {});
    day[ref] = (day[ref] || 0) + m;
    save();
  }
  const spentOnDay = (ref, dk) => ((spentAll()[dk] || {})[ref] || 0);
  function spentEver(ref){
    let n = 0;
    Object.keys(spentAll()).forEach(dk => { n += (spentAll()[dk][ref] || 0); });
    return n;
  }
  // Everything spent on a given day, as { ref: minutes }.
  const spentDay = dk => spentAll()[dk] || {};

  function timerLoad(){
    try { const raw = lsGet(TIMER_KEY); if (raw) timer = Object.assign(timer, JSON.parse(raw)); } catch(_){}
    const today = dayKey(new Date());
    if (timer.doneOn !== today){ timer.done = 0; timer.doneOn = today; }
    if (timerRunning() && timerLeft() <= 0){ timer.endsAt = null; timer.leftMs = timer.mins * 60000; }
  }
  const timerSave = () => { try { lsSet(TIMER_KEY, JSON.stringify(timer)); } catch(_){} };
  const timerRunning = () => !!timer.endsAt;
  const timerLeft = () => timer.endsAt ? Math.max(0, timer.endsAt - Date.now()) : Math.max(0, timer.leftMs);
  const timerFace = ms => { const s = Math.ceil(ms / 1000); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };

  // Bank whatever has actually elapsed since the clock last started, then stop
  // counting. Called from every way a timer can stop, so no minute is counted
  // twice and none is lost.
  function timerBank(){
    if (!timer.startedAt) return 0;
    const m = Math.round((Date.now() - timer.startedAt) / 60000);
    timer.startedAt = null;
    if (m >= 1 && timer.target) logTime(timer.target, m);
    return m;
  }
  function timerStart(){
    timer.endsAt = Date.now() + (timer.leftMs > 0 ? timer.leftMs : timer.mins * 60000);
    timer.startedAt = Date.now();
    timerSave(); timerLoop(); paintPanels();
  }
  function timerPause(){
    timerBank();
    timer.leftMs = timerLeft(); timer.endsAt = null;
    clearInterval(timerTick); timerSave(); paintPanels();
  }
  function timerReset(mins){
    timerBank();
    if (mins) timer.mins = mins;
    timer.endsAt = null; timer.leftMs = timer.mins * 60000;
    clearInterval(timerTick); timerSave(); paintPanels();
  }
  function timerFinish(){
    timerBank();
    timer.endsAt = null; timer.leftMs = timer.mins * 60000;
    timer.done = (timer.done || 0) + 1; timer.doneOn = dayKey(new Date());
    timerSave();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch(_){}
    markJustDone('timer');
    paintPanels();
  }
  function timerLoop(){
    clearInterval(timerTick);
    if (!timerRunning()) return;
    // Only the digits are rewritten each second. A full render every second
    // would fight anything being typed anywhere else on the page.
    timerTick = setInterval(() => {
      const left = timerLeft();
      const face = document.getElementById('ath-face');
      if (face) face.textContent = timerFace(left);
      if (left <= 0){ clearInterval(timerTick); timerFinish(); }
    }, 250);
  }

  // What the clock could be counting for. The block you are in comes first,
  // because nine times in ten that is the answer.
  function timerTargets(){
    const now = new Date(), vd = viewDate(), dk = dayKey(vd);
    const t = dayKey(now) === dk ? (now.getHours() * 60 + now.getMinutes()) : -1;
    const out = [];
    blocksForDate(vd).filter(b => !b.allDay).forEach(b => {
      const id = b.task ? 'tk_' + b.task.id : (b.routine ? 'ro_' + b.routine.id : b.id);
      out.push({ id: id, label: b.t, live: t >= mins(b.s) && t < mins(b.e) });
    });
    openTasks(vd).filter(tk => taskAvailableOn(tk, vd)).slice(0, 12).forEach(tk => {
      if (out.some(o => o.id === 'tk_' + tk.id)) return;
      out.push({ id: 'tk_' + tk.id, label: tk.title });
    });
    return out;
  }

  function timerHTML(){
    const left = timerLeft(), running = timerRunning();
    const idle = !running && left === timer.mins * 60000;
    const targets = timerTargets();
    // Default to whatever is happening now, but only while nothing is running,
    // so the clock never quietly changes what it is counting mid-session.
    if (!running && !timer.target){
      const live = targets.find(x => x.live);
      if (live) timer.target = live.id;
    }
    let h = '<div class="panel tmr'+(running ? ' going' : '')+(justDone === 'timer' ? ' just' : '')+'">';
    h += '<div class="panel-h">Focus</div>';
    h += '<div class="tmr-face" id="ath-face">'+timerFace(left)+'</div>';
    h += '<select class="tmr-on" id="tmr_on" data-timertarget'+(running ? ' disabled' : '')+'>'+
      '<option value="">Nothing in particular</option>'+
      targets.map(x => '<option value="'+esc(x.id)+'"'+(timer.target === x.id ? ' selected' : '')+'>'+
        esc(x.label)+(x.live ? ' · now' : '')+'</option>').join('')+
      '</select>';
    h += '<div class="tmr-mins">'+TIMER_MINS.map(mn =>
      '<button class="'+(timer.mins === mn ? 'on' : '')+'" data-timerset="'+mn+'">'+mn+'</button>').join('')+
      '<span>min</span></div>';
    h += '<div class="tmr-act">'+
      (running ? '<button class="go" data-timerpause>Pause</button>'
               : '<button class="go" data-timerstart>'+(idle ? 'Start' : 'Resume')+'</button>')+
      (idle ? '' : '<button class="ghost" data-timerreset>Reset</button>')+
      '</div>';
    const today = dayKey(new Date());
    const spentToday = Object.keys(spentDay(today)).reduce((a, k) => a + spentDay(today)[k], 0);
    h += '<div class="tmr-done">'+
      (timer.done ? timer.done + ' finished today' : 'Nothing finished yet today')+
      (spentToday ? ' · '+dur(spentToday)+' tracked' : '')+'</div>';
    h += '</div>';
    return h;
  }

  /* The pile still to be given a place. Rows are draggable, which is a desktop
     affordance and deliberately so: touch has no equivalent, so on a phone a
     task is placed by opening it and setting a time, which works everywhere. */
  function placePanelHTML(vd){
    const list = unplacedTasks(vd);
    let h = '<div class="panel place"><div class="panel-h">To place'+
      (list.length ? '<b>'+list.length+'</b>' : '')+'</div>';
    if (!list.length){
      h += '<p class="park-empty">Nothing waiting. Everything for this day has a time or a block.</p>';
    } else {
      h += '<div class="plist">' + list.map(tk => {
        const bits = [];
        if (tk.priority === 'high') bits.push('High');
        if (tk.due){ const dl = dueLabel(tk.due, vd, tk.dateType); bits.push(dl.text); }
        if (tk.mins) bits.push(dur(tk.mins));
        // Tickable from here too. Something overdue whose category has no block
        // today shows in this panel and nowhere else, so without a tick there
        // would be no way to finish it short of opening the editor.
        const col = catColor(tk.cat);
        return '<div class="ptask" draggable="true" data-dragtask="'+tk.id+'">'+
          '<button class="ptick" data-tasktoggle="'+tk.id+'|'+dayKey(vd)+'" aria-label="Tick off '+esc(tk.title)+'">'+
            '<span class="mark" style="border-color:'+col+'">'+TICK+'</span></button>'+
          '<span class="pt"><b>'+esc(tk.title)+'</b>'+
          (bits.length ? '<em>'+esc(bits.join(' · '))+'</em>' : '')+'</span></div>';
      }).join('') + '</div>';
      h += '<p class="place-hint">Drag one onto a block to do it then, or onto empty time to fix a slot.</p>';
    }
    return h + '</div>';
  }

  // Panels live outside #soft-app, so they survive its re-renders and are
  // painted separately. Cleared entirely when the screen is too narrow, or when
  // the main column is showing something that owns the whole screen.
  function paintPanels(){
    const L = document.getElementById('ath-left'), R = document.getElementById('ath-right');
    if (!L || !R) return;
    const busy = loadFailed || bootBroken || ob || needsOnboarding() || (cloud && !session);
    if (!panelsOn() || busy){
      L.hidden = R.hidden = true; L.innerHTML = R.innerHTML = '';
      return;
    }
    const vd = viewDate(), dk = dayKey(vd);
    const park = '<div class="panel"><div class="panel-h">Scratchpad</div>'+parkHTML(dk, true)+'</div>';
    // The pile to place and a block's contents only exist on the Day view:
    // there is nothing to drop onto or pick from anywhere else.
    const dayOn = view === 'day' && !weekShown();
    const place = dayOn ? placePanelHTML(vd) : '';
    // What is in a block sits beside the grid you pick it from. On a phone
    // there is no panel, and it opens under the grid instead.
    let blk = '';
    if (dayOn){
      const det = dayDetailHTML(vd, new Date(), upcomingHomes(vd));
      blk = '<div class="panel blk"><div class="panel-h">In this block</div>'+
        (det || '<p class="blk-empty">Click a block on the day to see what is waiting in it.</p>')+'</div>';
    }
    if (twoPanels()){
      // Left is for capture: the scratchpad on top, the pile to place under it.
      // Right is the clock, with whichever block you are looking at under it.
      L.hidden = R.hidden = false;
      L.innerHTML = park + place;
      R.innerHTML = timerHTML() + blk;
    } else {
      // One rail only: the same order, top to bottom.
      L.hidden = true; L.innerHTML = '';
      R.hidden = false; R.innerHTML = timerHTML() + blk + park + place;
    }
  }

  function parkHTML(dk, inPanel){
    let h = '<div class="park'+(inPanel ? ' inpanel' : '')+'"><div class="park-row">'+
      '<input id="sk" type="text" placeholder="Park a stray thought…" autocomplete="off">'+
      '<button data-park>Park</button></div>';
    // A parked thought is not always a calendar entry. It might be a job, a
    // thing to keep, or something at a fixed time, and the arrow used to assume
    // one of those four. Asking takes one tap and gets it right every time.
    h += (S.parked||[]).length
      ? '<ul class="parked">'+S.parked.map((p,i) => {
          const open = parkOpen === i;
          return '<li'+(open ? ' class="open"' : '')+'><span>'+esc(p.t)+'</span>'+
          '<button class="parkdo'+(open ? ' on' : '')+'" data-parkopen="'+i+'" aria-label="Turn this into something" title="Turn this into something">'+(open ? '×' : '→')+'</button>'+
          '<button data-unpark="'+i+'" aria-label="Remove">×</button>'+
          (open ? '<div class="parkinto">'+
            '<button data-parkinto="task|'+i+'|'+dk+'">Task</button>'+
            '<button data-parkinto="appt|'+i+'|'+dk+'">Appointment</button>'+
            '<button data-parkinto="note|'+i+'|'+dk+'">Note</button>'+
            '<button data-parkinto="block|'+i+'|'+dk+'">Block</button>'+
            '</div>' : '')+
          '</li>';
        }).join('')+'</ul>'
      : '<p class="park-empty">Nothing here yet. When something pops into your head mid-task, leave it here and come back to it later.</p>';
    h += '</div>';
    return h;
  }

  /* ---------- event editor (create / edit / delete) ---------- */
  function openEditor(opts){
    // opts: { id?, date? }  — editing an event, and/or a default date for a new one
    clearModalDrafts();
    const dk = opts.date || dayKey(new Date());
    if (opts.id){
      const e = findEvent(opts.id);
      if (!e) return;
      const r = e.rrule;
      editing = {
        id: e.id, date: dk,
        title: e.title, note: e.note || '', cat: e.cat, allDay: !!e.allDay,
        start: e.start || '09:00', end: e.end || '10:00',
        repeat: !r ? 'once' : (r.freq === 'daily' ? 'daily' : r.freq === 'monthly' ? 'monthly' : (r.interval === 2 ? 'fortnightly' : (r.weekdays && r.weekdays.length === 5 && r.weekdays.indexOf(0)===-1 && r.weekdays.indexOf(6)===-1 ? 'weekdays' : 'weekly'))),
        weekdays: (r && r.weekdays) ? r.weekdays.slice() : [parseDay(dk).getDay()],
        onceDate: (!r ? (e.date || dk) : dk),
        monthday: (r && r.monthday) || parseDay(dk).getDate()
      };
    } else {
      const D = parseDay(dk);
      editing = {
        id: null, date: dk,
        title: opts.title || '', note: opts.note || '',
        cat: opts.cat || (S.categories[0]||{}).id, allDay: false,
        start: '09:00', end: '10:00',
        repeat: 'once', weekdays: [D.getDay()], onceDate: dk, monthday: D.getDate(),
        fromParked: (opts.fromParked == null ? null : opts.fromParked)
      };
    }
    render();
  }
  function editorHTML(){
    const ed = editing;
    const CATOPTS = S.categories.map(c => "<option value='"+c.id+"'"+(c.id===ed.cat?' selected':'')+">"+esc(c.label)+"</option>").join('');
    const REPEATS = [['once','Once'],['daily','Every day'],['weekdays','Weekdays'],['weekly','Weekly'],['fortnightly','Fortnightly'],['monthly','Monthly']];
    const WD = [[1,'M'],[2,'T'],[3,'W'],[4,'T'],[5,'F'],[6,'S'],[0,'S']];
    let h = '<div class="modal-back" data-closeeditor></div>';
    h += '<div class="modal"><div class="modal-h">'+(ed.id?'Edit event':'New event')+'</div>';
    h += '<label class="fld"><span>What</span><input id="e_title" type="text" placeholder="Name it" value="'+esc(ed.title)+'" autocomplete="off"></label>';
    h += '<label class="fld"><span>Note</span><input id="e_note" type="text" placeholder="Optional detail" value="'+esc(ed.note)+'" autocomplete="off"></label>';
    h += '<label class="fld"><span>Category</span><select id="e_cat">'+CATOPTS+'</select></label>';
    h += '<label class="fld chk"><input id="e_allday" type="checkbox"'+(ed.allDay?' checked':'')+'><span>All day</span></label>';
    if (!ed.allDay){
      h += '<div class="fld two"><label><span>Start</span><input id="e_start" type="time" value="'+ed.start+'"></label>'+
        '<label><span>End</span><input id="e_end" type="time" value="'+ed.end+'"></label></div>';
    }
    h += '<label class="fld"><span>Repeat</span><select id="e_repeat">'+
      REPEATS.map(r=>"<option value='"+r[0]+"'"+(r[0]===ed.repeat?' selected':'')+">"+r[1]+"</option>").join('')+'</select></label>';
    if (ed.repeat === 'once'){
      h += '<label class="fld"><span>On</span><input id="e_date" type="date" value="'+ed.onceDate+'"></label>';
    } else if (ed.repeat === 'weekly' || ed.repeat === 'fortnightly'){
      h += '<div class="fld"><span>On</span><div class="wdrow">'+
        WD.map(w=>'<button type="button" class="wdbtn'+(ed.weekdays.indexOf(w[0])!==-1?' on':'')+'" data-wd="'+w[0]+'">'+w[1]+'</button>').join('')+
        '</div></div>';
    } else if (ed.repeat === 'monthly'){
      h += '<label class="fld"><span>Day of month</span><input id="e_monthday" type="number" min="1" max="31" value="'+ed.monthday+'"></label>';
    }
    h += '<div class="modal-actions">';
    if (ed.id) h += '<button class="del" data-delevent="'+ed.id+'">Delete</button>';
    h += '<span style="flex:1"></span><button class="ghost" data-closeeditor>Cancel</button>'+
      '<button class="go" data-saveevent>Save</button></div>';
    h += '</div>';
    return h;
  }
  // Pull current form values into `editing` before a re-render or save.
  function syncEditor(){
    if (!editing) return;
    const g = id => document.getElementById(id);
    if (g('e_title')) editing.title = g('e_title').value;
    if (g('e_note'))  editing.note  = g('e_note').value;
    if (g('e_cat'))   editing.cat   = g('e_cat').value;
    if (g('e_allday')) editing.allDay = g('e_allday').checked;
    if (g('e_start')) editing.start = g('e_start').value;
    if (g('e_end'))   editing.end   = g('e_end').value;
    if (g('e_repeat')) editing.repeat = g('e_repeat').value;
    if (g('e_date'))  editing.onceDate = g('e_date').value;
    if (g('e_monthday')) editing.monthday = +g('e_monthday').value || 1;
  }
  function commitEvent(){
    syncEditor();
    const ed = editing;
    if (!ed.title.trim()){ const i = document.getElementById('e_title'); if (i) i.focus(); return; }
    let rrule = null, date = null;
    const from = ed.repeat === 'once' ? ed.onceDate : weekKey(parseDay(ed.onceDate || ed.date));
    if (ed.repeat === 'once'){ date = ed.onceDate; }
    else if (ed.repeat === 'daily'){ rrule = { freq:'daily', interval:1, from: ed.date }; }
    else if (ed.repeat === 'weekdays'){ rrule = { freq:'weekly', interval:1, weekdays:[1,2,3,4,5], from: weekKey(parseDay(ed.date)) }; }
    else if (ed.repeat === 'weekly' || ed.repeat === 'fortnightly'){
      const wds = ed.weekdays.length ? ed.weekdays.slice().sort() : [parseDay(ed.date).getDay()];
      rrule = { freq:'weekly', interval: ed.repeat==='fortnightly'?2:1, weekdays: wds, from: weekKey(parseDay(ed.date)) };
    }
    else if (ed.repeat === 'monthly'){ rrule = { freq:'monthly', interval:1, monthday: ed.monthday, from: ed.date }; }

    const base = {
      title: ed.title.trim().slice(0,120),
      note: ed.note.trim().slice(0,200),
      cat: ed.cat,
      allDay: ed.allDay,
      start: ed.allDay ? null : (ed.start || '09:00'),
      end: ed.allDay ? null : (ed.end || '10:00'),
      rrule, date
    };
    if (ed.id){
      const e = findEvent(ed.id);
      if (e) Object.assign(e, base);   // keep ex/skip
    } else {
      S.events.push(Object.assign({ id:'ev_'+uid8(), ex:{}, skip:[] }, base));
      // scheduled straight from a parked thought? clear it off the list
      if (ed.fromParked != null && S.parked && S.parked[ed.fromParked]) S.parked.splice(ed.fromParked, 1);
    }
    editing = null;
    clearModalDrafts();
    save(); render();
  }

  /* ==========================================================================
     Paint & render
     ========================================================================== */
  const drafts = {};
  function keepDrafts(){
    // A file input is never a draft. Browsers refuse to have its value written
    // back, so remembering one turns the next render into an exception.
    const keep = e => {
      if (!e.target.id || e.target.type === 'file') return;
      drafts[e.target.id] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    };
    shell.addEventListener('input',  keep);
    shell.addEventListener('change', keep);
    // Six digits in means they are done typing, or the phone has just autofilled
    // the code from the email. Making them reach for a button after that is a
    // small insult, so submit it.
    shell.addEventListener('input', e => {
      if (e.target.id !== 'auth_code' || authBusy) return;
      if (e.target.value.replace(/\D/g, '').length === 6) verifyCode();
    });
    /* ---- placing a task by dragging it ----
       Desktop only, and honestly so: HTML5 drag has no touch equivalent, so a
       phone places a task by opening it and setting a time, which works
       everywhere. Where it lands decides what it means. Empty time fixes a
       slot; a block means "do it during that", with no minute attached. */
    let dragTask = null;
    shell.addEventListener('dragstart', e => {
      const row = e.target.closest && e.target.closest('[data-dragtask]');
      if (!row) return;
      dragTask = row.dataset.dragtask;
      try { e.dataTransfer.setData('text/plain', dragTask); e.dataTransfer.effectAllowed = 'move'; } catch(_){}
      document.body.classList.add('dragging-task');
    });
    shell.addEventListener('dragend', () => {
      dragTask = null;
      document.body.classList.remove('dragging-task');
      app.querySelectorAll('.dropping').forEach(el => el.classList.remove('dropping'));
    });
    shell.addEventListener('dragover', e => {
      if (!dragTask) return;
      const zone = e.target.closest && e.target.closest('.dblk, .dcol, .place');
      if (!zone) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch(_){}
      const mark = zone.classList.contains('place') ? null : zone;
      app.querySelectorAll('.dropping').forEach(el => { if (el !== mark) el.classList.remove('dropping'); });
      if (mark) mark.classList.add('dropping');
    });
    shell.addEventListener('drop', e => {
      if (!dragTask) return;
      const zone = e.target.closest && e.target.closest('.dblk, .dcol, .place');
      if (!zone) return;
      e.preventDefault();
      const tk = findTask(dragTask);
      dragTask = null;
      document.body.classList.remove('dragging-task');
      app.querySelectorAll('.dropping').forEach(el => el.classList.remove('dropping'));
      if (!tk) return;
      const vd = viewDate(), dk = dayKey(vd);

      if (zone.classList.contains('place')){
        // Dragged back to the pile: it has no place again, and it is held there
        // so autofill does not immediately pour it back into a block.
        tk.at = null; tk.pin = null; tk.hold = true;
        save(); render(); return;
      }
      if (zone.classList.contains('dblk')){
        const id = zone.dataset.blockid;
        const b = blocksForDate(vd).find(x => String(x.uid || x.id) === id);
        // Only a real block can hold a task. A goal step, an appointment or a
        // routine is not a container, so dropping on one does nothing.
        if (!b || b.step || b.task || b.routine) return;
        tk.at = null; tk.hold = false;
        tk.pin = { b: b.id, d: dk };
        openDayBlock = String(b.uid || b.id);
        save(); render(); return;
      }
      // Empty time: fix a slot, snapped to the quarter hour.
      const box = zone.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
      const m = Math.round((DS + frac * SPAN) / 15) * 15;
      tk.pin = null; tk.hold = false;
      tk.due = dk; tk.dateType = 'on';
      tk.at = fmtM(Math.min(DE - 15, Math.max(DS, m)));
      if (!tk.mins) tk.mins = 30;
      save(); render();
    });

    /* Paste and drop, for the laptop. On a phone the picker is the whole story,
       but at a desk a screenshot lives on the clipboard and a photo lives in a
       folder, and making someone save one out and pick it back up is silly.

       Paste only counts while a note is open, so it can never be ambiguous
       about where the picture is meant to land. A drop onto the board, where
       there is no open note, makes a new one and holds it open to be titled. */
    document.addEventListener('paste', e => {
      if (!noteEdit) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (let i = 0; i < items.length; i++){
        if (items[i].type && items[i].type.indexOf('image/') === 0){
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;              // ordinary text paste: leave it alone
      e.preventDefault();
      noteSync();
      addNoteImages(files);
    });

    const dropOK = () => !!noteEdit || view === 'notes';
    const carriesFiles = dt => dt && Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
    let dragOn = false;
    const setDrag = on => {
      if (dragOn === on) return;
      dragOn = on;
      app.classList.toggle('dropping', on);
    };
    window.addEventListener('dragover', e => {
      if (!dropOK() || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDrag(true);
    });
    // relatedTarget is null when the pointer leaves the window entirely.
    window.addEventListener('dragleave', e => { if (!e.relatedTarget) setDrag(false); });
    window.addEventListener('drop', e => {
      if (!dropOK() || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDrag(false);
      const files = e.dataTransfer.files;
      if (!Array.prototype.some.call(files || [], f => /^image\//.test(f.type || ''))) return;
      if (noteEdit){ noteSync(); addNoteImages(files); return; }
      if (!cloud || !session){ alert('Photos need an account, so they can be stored safely and reach your other devices. Sign in first.'); return; }
      const n = newNote('text');
      noteEdit = n; save(); render();
      addNoteImages(files, n);
    });

    // A routine's name and time edit in place, saved as you go, with no render
    // in between so the cursor stays where you put it.
    shell.addEventListener('input', e => {
      const id = e.target.dataset && (e.target.dataset.rname || e.target.dataset.rtime);
      if (!id) return;
      const r = routinesAll().find(x => x.id === id);
      if (!r) return;
      if (e.target.dataset.rname) r.name = e.target.value.slice(0, 60);
      else if (e.target.value) r.time = e.target.value;
      save();
    });

    shell.addEventListener('change', e => {
      if (e.target.id !== 'tmr_on') return;
      timer.target = e.target.value;
      timerSave();
    });

    // Changing a category in the assistant's preview, one task or all of them.
    // Choosing one clears the "guessed" mark: a person has now decided.
    shell.addEventListener('change', e => {
      if (!aiPreview || !e.target.dataset) return;
      const one = e.target.dataset.aicat;
      const all = e.target.hasAttribute('data-aicatall');
      if (one == null && !all) return;
      const tks = aiPreview.tasks || [];
      if (all){
        if (!e.target.value) return;
        tks.forEach(x => { x.cat = e.target.value; x.catGuessed = false; });
      } else {
        const x = tks[+one];
        if (x){ x.cat = e.target.value; x.catGuessed = false; }
      }
      render();
    });

    // Picking a photo. noteSync first, or whatever was being typed is lost to
    // the re-render that follows the upload.
    shell.addEventListener('change', e => {
      if (e.target.id !== 'ne_file') return;
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f){ noteSync(); addNoteImage(f); }
    });
    // Notes filter as you type. Re-rendering blows the field away, so put the
    // cursor back exactly where it was afterwards.
    shell.addEventListener('input', e => {
      if (e.target.id !== 'nt_search') return;
      noteSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = document.getElementById('nt_search');
      if (el){ el.focus(); try { el.setSelectionRange(pos, pos); } catch(_){} }
    });
  }
  const clearDraft = id => { delete drafts[id]; };
  const MODAL_IDS = ['e_title','e_note','e_cat','e_allday','e_start','e_end','e_repeat','e_date','e_monthday','s_name',
    'te_title','te_note','te_cat','te_prio','te_rep','te_due','te_when','te_mins','te_at','tk_when','tk_mins',
    'ne_title','ne_body','ne_cat','ne_newitem'];
  const clearModalDrafts = () => MODAL_IDS.forEach(clearDraft);

  function paint(h){
    const ae = document.activeElement;
    const focusId = (ae && ae.id) ? ae.id : null;
    let caret = null;
    try { caret = (ae && ae.selectionStart != null) ? ae.selectionStart : null; } catch(_){}
    const sy = (typeof window !== 'undefined' && window.scrollY) || 0;
    app.innerHTML = h;
    // Panels are redrawn before drafts and focus are put back, so a half-typed
    // thought in the scratchpad panel survives a render like any other field.
    paintPanels();
    Object.keys(drafts).forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.type === 'file') return;      // belt and braces: see keepDrafts
      if (el.type === 'checkbox') el.checked = drafts[id]; else el.value = drafts[id];
    });
    if (focusId){
      const el = document.getElementById(focusId);
      if (el){ el.focus(); if (caret != null && el.setSelectionRange){ try { el.setSelectionRange(caret, caret); } catch(_){} } }
    }
    if (typeof window !== 'undefined' && window.scrollTo && sy) window.scrollTo(0, sy);
    if (app.querySelector('img[data-imgpath]')) hydrateImages();
    watchPickbar();
  }

  // The phone's pick bar points down at the block's detail, so once the detail
  // is on screen the bar has nothing left to say and gets out of the way.
  let pickObs = null;
  function watchPickbar(){
    if (pickObs){ pickObs.disconnect(); pickObs = null; }
    const bar = app.querySelector('.pickbar'), det = app.querySelector('.ddet');
    if (!bar || !det || typeof IntersectionObserver === 'undefined') return;
    pickObs = new IntersectionObserver(es => { bar.classList.toggle('away', es[0].isIntersecting); });
    pickObs.observe(det);
  }

  // Prev / next / back-to-today for the Day and Week views.
  function dateNav(vd, now){
    // Only the calendar is tied to a date. Blocks, tasks, habits and goals are
    // not, so they get no date strip at all.
    if (view !== 'day') return '';
    const step = weekShown() ? (phoneGrid() ? 3 : 7) : 1;
    let label, rel = '';
    if (!weekShown()){
      const diff = daysBetween(dayKey(now), dayKey(vd));
      rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : '';
      label = DAYS[vd.getDay()] + ' ' + vd.getDate() + ' ' + SHORT[vd.getMonth()];
    } else {
      if (phoneGrid()){
        const end = new Date(vd); end.setDate(vd.getDate() + 2);
        const dd = daysBetween(dayKey(now), dayKey(vd));
        rel = dd === 0 ? 'Next three days' : '';
        label = vd.getDate() + ' ' + SHORT[vd.getMonth()] + ' to ' + end.getDate() + ' ' + SHORT[end.getMonth()];
      } else {
        const mon = parseDay(weekKey(vd));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const wdiff = Math.round(daysBetween(weekKey(now), weekKey(vd)) / 7);
        rel = wdiff === 0 ? 'This week' : wdiff === 1 ? 'Next week' : wdiff === -1 ? 'Last week' : '';
        label = mon.getDate() + ' ' + SHORT[mon.getMonth()] + ' – ' + sun.getDate() + ' ' + SHORT[sun.getMonth()];
      }
    }
    let h = '<div class="datenav">';
    h += '<button class="dnav" data-shift="'+(-step)+'" aria-label="Previous">‹</button>';
    h += '<span class="dnlabel"><b>'+esc(label)+'</b>'+(rel ? '<small>'+rel+'</small>' : '')+'</span>';
    h += '<button class="dnav" data-shift="'+step+'" aria-label="Next">›</button>';
    if (dayShift !== 0) h += '<button class="dntoday" data-today>'+(weekShown() ? 'This week' : 'Today')+'</button>';
    h += '</div>';
    return h;
  }

  function loadFailedHTML(){
    return '<div class="ob"><div class="ob-mark">' + MOON + '</div>'+
      '<h1>'+(bootBroken ? 'Athena did not load properly' : 'Could not reach your data')+'</h1>'+
      '<p class="ob-sub">'+(bootBroken
        ? 'Part of Athena is missing on this device, so it cannot reach your account. This is almost always a bad copy cached here, and getting the latest version fixes it. Nothing has been changed or lost.'
        : 'Athena could not load your account just now, so it is not showing anything rather than risk showing you the wrong thing. Nothing has been changed or lost.')+'</p>'+
      '<div class="errdetail"><b>What went wrong</b><span>'+esc(bootBroken ? whyNoAccount() : (loadError || 'unknown'))+'</span></div>'+
      '<div class="ob-actions"><button class="ghost" data-export>Download a backup</button><span style="flex:1"></span>'+
      (bootBroken ? '<button class="go" data-forceupdate>Get the latest version</button>'
                  : '<button class="go" data-retryload>Try again</button>')+'</div>'+
      '<button class="linkish ob-skip" data-worklocal>Carry on with this device for now</button>'+
      '<div class="buildline">Version '+BUILD+(session ? ' · signed in as '+esc(session.user.email || '') : ' · not signed in')+'</div></div>';
  }

  function render(){
    if ((loadFailed || bootBroken) && !workLocal){ app.classList.remove('wide'); paint(loadFailedHTML()); return; }
    // `ob` is also set when someone reruns setup from Settings, which is why
    // this is not gated on needsOnboarding alone.
    if (ob || needsOnboarding()){ app.classList.remove('wide'); paint(onboardingHTML()); return; }
    const now = new Date();
    const vd = viewDate();
    const hr = now.getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const name = (S.profile && S.profile.name) ? ', ' + esc(S.profile.name) : '';
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    let h = '';

    // The daily drawing now sits with the greeting where it belongs, and the
    // settings control is a cog that looks like what it does.
    h += '<div class="greet"><div class="gtxt"><h1>'+greet+name+
      '<span class="namemotif" aria-hidden="true">'+(hr >= 20 || hr < 5 ? MOON : MOTIFS[doy % MOTIFS.length])+'</span></h1>'+
      '<p>'+DAYS[now.getDay()]+' '+now.getDate()+' '+MON[now.getMonth()]+' · '+
      clockOf(pad(now.getHours())+':'+pad(now.getMinutes()))+'</p></div>'+
      '<button class="cog" data-settings aria-label="Settings">'+COG+'</button></div>';
    h += '<div class="quote"><p>'+esc(LINES[doy % LINES.length])+'</p></div>';

    // Blocks are a top-level place now, not a mode hidden inside the week. Today
    // and the whole week are two views of the same calendar, so they share a tab
    // and a toggle instead of spending two slots in the row.
    h += '<div class="segrow"><div class="seg">'+
      [['day','Day'],['blocks','Blocks'],['tasks','Tasks'],['grow','Grow'],['notes','Notes']].map(v =>
        '<button data-view="'+v[0]+'"'+(view===v[0]?' class="on"':'')+'>'+v[1]+'</button>').join('')+
      '</div>'+
      (view==='day' ? '<div class="seg sub">'+
        [['today','Today'],['week','Whole week']].map(m =>
          '<button data-daymode="'+m[0]+'"'+(dayMode===m[0]?' class="on"':'')+'>'+m[1]+'</button>').join('')+
        '</div>' : '')+
      (view==='grow' ? '<div class="seg sub">'+
        [['habits','Habits'],['goals','Goals'],['routines','Routines']].map(m =>
          '<button data-growmode="'+m[0]+'"'+(growMode===m[0]?' class="on"':'')+'>'+m[1]+'</button>').join('')+
        '</div>' : '')+
      (weekShown() && canGrid() ? '<button class="expand" data-expand="1">'+(expanded?'Collapse to strips':'Expand to full grid')+'</button>' : '')+
      (weekShown() && !canGrid() ? '<button class="expand" data-weekmode="1">'+(weekMode==='days'?'See all 7 days':'See 3 days')+'</button>' : '')+
      '</div>';
    app.classList.toggle('wide', weekShown() && gridShown());

    h += dateNav(vd, now);

    if (view === 'day')    h += weekShown() ? weekView(vd, now) : dayRail(vd, now);
    else if (view === 'blocks') h += blocksManagerHTML(now);
    else if (view === 'tasks')  h += tasksView(now);
    else if (view === 'grow')   h += growMode === 'goals' ? goalsView(now)
                                   : growMode === 'routines' ? routinesView(now)
                                   : habitsView(now);
    else if (view === 'notes')  h += notesView(now);

    // Parked thoughts live under the Day view, unless a wide screen has taken
    // them into a panel, where they are always to hand.
    if (view === 'day' && !panelsOn()){ h += parkHTML(dayKey(vd)); }

    // One banner, in order of how much it matters. Stacking three warnings that
    // all mean "not syncing" just teaches people to ignore the strip.
    if (loadFailed)
      h += '<div class="savewarn">Working on this device only. Athena cannot reach your account, so your changes are being kept here and nothing is being overwritten. '+
        '<button class="linkish" data-retryload>Try connecting again</button></div>';
    else if (!ok)
      h += '<div class="savewarn">Not saving to your account right now. Recent changes are only on this device.</div>';
    // Running with no account at all is the failure that hides itself, because
    // the app looks perfectly healthy while nothing leaves the device.
    else if (!cloud || !session)
      h += '<div class="savewarn">Not signed in, so nothing is syncing. This device is saving on its own. Open Settings to fix it.</div>';
    const savedLine = loadFailed ? 'Saved on this device. Not syncing.'
      : !ok ? 'Not saving right now.'
      : (cloud && session) ? 'Synced to your account. Saves as you go, on every device.'
      : 'Everything saves as you go, on this device.';
    h += '<footer>'+savedLine+'</footer>';

    if (celebrate) h += '<div class="celebrate"><span>'+esc(celebrate)+'</span></div>';
    if (undoState) h += '<div class="undobar"><span>'+esc(undoState.label)+'</span><button data-undo>Undo</button></div>';
    if (editing) h += editorHTML();
    if (taskEdit) h += taskEditorHTML();
    if (noteEdit) h += noteEditorHTML();
    if (settingsOpen) h += settingsHTML();
    if (aiOpen) h += aiHTML();

    paint(h);
  }

  // Sign-in needs three things in place: the config, the Supabase library, and a
  // session. Saying which one is missing is the difference between a fix and a
  // fortnight of guessing, and it costs a line of text.
  function whyNoAccount(){
    const boot = (window.ATHENA_BOOT_ERRORS || []).join('; ');
    const bits = [];
    if (!CFG) bits.push('the Supabase settings did not load (supabase-config.js)');
    if (!(window.supabase && window.supabase.createClient)) bits.push('the sign-in library did not load or would not run (vendor/supabase.js)');
    if (CFG && window.supabase && !sb) bits.push('the sign-in client could not be created');
    if (cloud && !session) bits.push('no active session on this device');
    if (!bits.length) bits.push('unknown');
    return bits.join('. ') + (boot ? '. Errors: ' + boot : '') + '.';
  }

  /* ---------- getting your data out, and getting unstuck ----------
     Athena had no way to take a copy of your own data, which makes every "did I
     just lose that?" moment worse than it needs to be. This writes the whole
     blob to a file, so a device can be backed up before anything is changed on
     it. forceUpdate() tears out the offline cache and the service worker, which
     is what frees a device still serving a build from before sign-in existed. */
  function exportBackup(){
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'athena-backup-' + stamp + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch(_){ alert('Could not save the file. Try from a browser tab rather than the installed app.'); }
  }

  // An app added to the home screen keeps its own storage, separate from the
  // browser it was added from. Fixing the browser does nothing for the icon on
  // the home screen, and the icon has no address bar to type a fresh URL into,
  // so a device stuck on a bad cached copy had no way out from the inside.
  // This gives it one: ask the server what the current build is and, if this
  // copy is not it, clear everything out and reload. Once per launch, so a
  // failure cannot become a reload loop.
  async function updateIfStale(){
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = await r.json();
      if (!v || !v.build || v.build === BUILD) return;
      if (sessionStorage.getItem('athena:updating') === v.build) return;
      sessionStorage.setItem('athena:updating', v.build);
      await forceUpdate();
    } catch(_){ /* offline, or no version file: carry on with what we have */ }
  }

  async function forceUpdate(){
    try {
      if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
      if (navigator.serviceWorker){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch(_){}
    // Cache-busted so nothing in front of us can answer from a stale copy.
    location.replace(location.origin + location.pathname + '?fresh=' + Date.now());
  }

  /* ---------- settings (name + categories) ---------- */
  let settingsOpen = false;
  function settingsHTML(){
    let h = '<div class="modal-back" data-closesettings></div>';
    h += '<div class="modal"><div class="modal-h">Settings</div>';
    h += '<label class="fld"><span>Your name</span><input id="s_name" type="text" placeholder="What should Athena call you?" value="'+esc((S.profile&&S.profile.name)||'')+'" autocomplete="off"></label>';
    const th = themeChoice();
    h += '<div class="fld"><span>Appearance</span><div class="themerow">'+
      [['dark','Dark'],['light','Light'],['system','Match device']].map(t =>
        '<button class="themebtn'+(th===t[0]?' on':'')+'" data-settheme="'+t[0]+'">'+t[1]+'</button>').join('')+
      '</div></div>';
    h += '<div class="modal-h" style="margin-top:8px">Categories</div>';
    h += '<div class="catlist">';
    S.categories.forEach(c => {
      h += '<div class="catrow">'+
        '<input type="color" data-catcolor="'+c.id+'" value="'+c.color+'">'+
        '<input type="text" data-catlabel="'+c.id+'" value="'+esc(c.label)+'" autocomplete="off">'+
        (S.categories.length > 1 ? '<button class="del" data-delcat="'+c.id+'" aria-label="Remove">×</button>' : '<span style="width:22px"></span>')+
        '</div>';
    });
    h += '</div>';
    h += '<button class="go" data-addcat>+ Add category</button>';
    h += '<div class="modal-h" style="margin-top:8px">Your week</div>';
    h += '<label class="fld chk"><input id="s_autofill" type="checkbox" data-autofill'+(autofillOn()?' checked':'')+'>'+
      '<span>Fill blocks with matching tasks</span></label>';
    h += '<p class="setnote">On, a block offers everything of its category. Off, blocks stay empty until you put something in them. '+
      'Either way you can drag a task onto a block or a time on a wide screen.</p>';
    h += '<button class="ghost" data-obrerun>Walk me through setup again</button>';
    h += '<p class="setnote">The same questions as the first time, filled in with what you have now. '+
      'Change the hours, add a category, and Athena shows you exactly what it would move before anything happens.</p>';
    h += '<div class="modal-h" style="margin-top:8px">Account</div>';
    if (cloud && session){
      h += '<div class="acctrow"><span class="acctmail">'+esc(session.user.email || 'Signed in')+'</span>'+
        '<button class="ghost" data-signout>Sign out</button></div>';
    } else {
      // No account means nothing is syncing. Say so where it cannot be missed:
      // a silent local-only mode is indistinguishable from a working app.
      h += '<div class="savewarn">This device is not signed in to an account. '+
        'Everything is saved here only, and nothing is syncing.</div>';
      h += '<div class="errdetail"><b>Why</b><span>'+esc(whyNoAccount())+'</span></div>';
      h += '<button class="ghost" data-forceupdate>Get the latest version</button>';
    }
    h += '<div class="modal-h" style="margin-top:8px">Your data</div>';
    h += '<button class="ghost" data-export>Download a backup</button>';
    h += '<div class="buildline">Version '+BUILD+'</div>';
    h += '<div class="modal-actions"><span style="flex:1"></span><button class="go" data-closesettings>Done</button></div>';
    h += '</div>';
    return h;
  }

  /* ---------- Ask your AI — bring-your-own-assistant import ----------
     No connection to any AI: Athena hands the user a prompt, they paste the
     assistant's JSON reply back, and we preview then merge it (add-only). */
  let aiOpen = false, aiStep = 'input', aiPreview = null, aiError = '';

  function aiPrompt(){
    const cats = S.categories.map(c => c.label).join(' | ');
    return [
      'Reply with ONLY a JSON object in this exact shape, with no other words:',
      '{',
      '  "events": [ { "title": "", "category": "'+cats+'", "start": "HH:MM", "end": "HH:MM", "repeat": "once|daily|weekdays|weekly|fortnightly|monthly", "weekdays": [0,1,2,3,4,5,6], "date": "YYYY-MM-DD", "note": "" } ],',
      '  "tasks":  [ { "title": "", "category": "'+cats+'", "priority": "high|normal|low", "due": "YYYY-MM-DD", "dateType": "by|on", "minutes": 30, "at": "HH:MM", "repeat": "once|daily|weekly|monthly", "note": "" } ],',
      '  "habits": [ { "label": "", "category": "'+cats+'", "timesPerDay": 1 } ],',
      '  "goals":  [ { "title": "", "targetDate": "YYYY-MM-DD", "category": "'+cats+'", "steps": [ { "label": "", "freq": "daily|weekly|monthly" } ] } ]',
      '}',
      'Events are things with a time. Tasks are things to get done. Give each a category and priority. "due", "repeat" and "minutes" are optional.',
      'dateType says what the date means: "on" if it must happen that day, "by" if it just has to be finished by then. Default to "by".',
      'minutes is a rough estimate of how long the task takes, so it can be fitted into a block.',
      'at is only for a task that must happen at a set time, like an appointment. Leave it out otherwise.',
      'Rules: weekdays are 0=Sun … 6=Sat. Use "date" only when repeat is "once". Omit "start"/"end" for an all-day item. Skip any field you don\'t need. Today is '+dayKey(new Date())+'.',
      'Here is what I want: '
    ].join('\n');
  }

  // Also says whether it had to guess. Falling back to the first category is a
  // reasonable default, but doing it silently is how an entire import ends up
  // filed under Work without anyone being told.
  const matchCatInfo = (name) => {
    const n = String(name || '').trim().toLowerCase();
    const c = n ? S.categories.find(x => x.label.toLowerCase() === n || x.id === n) : null;
    return c ? { id: c.id, guessed: false } : { id: (S.categories[0] || {}).id, guessed: true };
  };
  const matchCat = name => matchCatInfo(name).id;

  function aiImportEvent(spec){
    const todayK = dayKey(new Date());
    const cat = matchCat(spec.category);
    const allDay = !spec.start;
    const rep = String(spec.repeat || 'weekly');
    const wds = Array.isArray(spec.weekdays) && spec.weekdays.length
      ? spec.weekdays.map(Number).filter(n => n >= 0 && n <= 6) : null;
    let rrule = null, date = null;
    if (rep === 'once') date = spec.date || todayK;
    else if (rep === 'daily') rrule = { freq:'daily', interval:1, from:todayK };
    else if (rep === 'weekdays') rrule = { freq:'weekly', interval:1, weekdays:[1,2,3,4,5], from:weekKey(new Date()) };
    else if (rep === 'monthly') rrule = { freq:'monthly', interval:1, monthday:(spec.monthday || (spec.date ? parseDay(spec.date).getDate() : new Date().getDate())), from:todayK };
    else rrule = { freq:'weekly', interval:(rep === 'fortnightly' ? 2 : 1), weekdays:(wds || [new Date().getDay()]), from:weekKey(new Date()) };
    return {
      id:'ev_'+uid8(), title:String(spec.title).slice(0,120), note:String(spec.note || '').slice(0,200),
      cat, allDay, start: allDay ? null : String(spec.start),
      end: allDay ? null : String(spec.end || fmtM(mins(String(spec.start)) + 60)),
      rrule, date, ex:{}, skip:[]
    };
  }

  function aiParse(text){
    let t = String(text || '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');   // tolerate code fences / stray prose
    if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  function aiWhen(ev){
    const time = ev.allDay ? 'All day' : clockOf(ev.start);
    if (!ev.rrule){ const x = parseDay(ev.date); return x.getDate()+' '+SHORT[x.getMonth()]+' · '+time; }
    const r = ev.rrule;
    if (r.freq === 'daily') return 'Daily · '+time;
    if (r.freq === 'monthly') return 'Monthly · '+time;
    // Read it the way a person would, not as a list of seven day names.
    const wd = (r.weekdays || []).slice().sort();
    const has = d => wd.indexOf(d) !== -1;
    let days;
    if (wd.length === 7) days = 'Every day';
    else if (wd.length === 5 && !has(0) && !has(6)) days = 'Weekdays';
    else if (wd.length === 2 && has(0) && has(6)) days = 'Weekends';
    else days = wd.map(d => SD[d]).join(' & ');
    return (r.interval === 2 ? 'Fortnightly, ' : '') + days + ' · ' + time;
  }

  function aiBuildPreview(rawOverride){
    const raw = rawOverride != null ? rawOverride : ((document.getElementById('ai_paste') || {}).value || '');
    let obj;
    try { obj = aiParse(raw); }
    catch(e){ aiError = "That didn't look like valid JSON. Paste the whole reply, or ask your AI to send JSON only."; render(); return; }
    const events = (Array.isArray(obj.events) ? obj.events : []).filter(e => e && e.title).map(aiImportEvent);
    const tasks = (Array.isArray(obj.tasks) ? obj.tasks : []).filter(x => x && x.title).map(x => {
      const rep = String(x.repeat || 'once');
      const out = {
        id:'tk_'+uid8(), title:String(x.title).slice(0,140), note:String(x.note || '').slice(0,200),
        cat: matchCatInfo(x.category).id,
        catGuessed: matchCatInfo(x.category).guessed,     // for the preview only, never saved
        priority: (['high','normal','low'].indexOf(x.priority) >= 0 ? x.priority : 'normal'),
        due: (typeof x.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.due)) ? x.due : null,
        dateType: (x.dateType === 'on' ? 'on' : 'by'),
        mins: (typeof x.minutes === 'number' && x.minutes > 0) ? Math.min(600, Math.round(x.minutes)) : null,
        repeat: (['daily','weekly','monthly'].indexOf(rep) >= 0) ? { freq: rep, interval: 1 } : null,
        at: null, createdAt: new Date().toISOString(), doneAt: null
      };
      out.at = normaliseAt(typeof x.at === 'string' ? x.at : '', out);
      return out;
    });
    const habits = (Array.isArray(obj.habits) ? obj.habits : []).filter(h => h && h.label).map(h => ({
      id:'hb_'+uid8(), label:String(h.label).slice(0,80), cat:matchCat(h.category),
      target: Math.max(1, Math.min(6, parseInt(h.timesPerDay, 10) || 1))
    }));
    const goals = (Array.isArray(obj.goals) ? obj.goals : []).filter(g => g && g.title).map(g => ({
      id:'g_'+uid8(), title:String(g.title).slice(0,120), by:(g.targetDate || ''), cat:matchCat(g.category),
      steps:(Array.isArray(g.steps) ? g.steps : []).filter(s => s && s.label).map(s => ({
        id:'st_'+uid8(), label:String(s.label).slice(0,120),
        freq:(['daily','weekly','monthly'].indexOf(s.freq) >= 0 ? s.freq : 'weekly')
      }))
    }));
    if (!events.length && !tasks.length && !habits.length && !goals.length){
      aiError = "I couldn't find any events, tasks, habits or goals in that reply. Check it and try again."; render(); return;
    }
    aiPreview = { events, tasks, habits, goals }; aiError = ''; aiStep = 'preview'; render();
  }

  // mode: 'place' fills blocks by length, 'list' holds the tasks back until
  // they are placed, '' is for an import with nothing to place.
  function aiApply(mode){
    if (!aiPreview) return;
    markUndo('Added from your assistant');        // snapshot first, so undo takes back the lot
    S.tasks = S.tasks || [];
    const tasks = (aiPreview.tasks || []).map(tk => { const c = Object.assign({}, tk); delete c.catGuessed; return c; });
    S.events.push.apply(S.events, aiPreview.events);
    S.tasks.push.apply(S.tasks, tasks);
    S.habits.push.apply(S.habits, aiPreview.habits);
    S.goals.push.apply(S.goals, aiPreview.goals);
    const pile = tasks.filter(placeable);
    if (mode === 'place' && pile.length) announce(placedSummary(placeByCapacity(pile, new Date())));
    else if (mode === 'list' && pile.length){
      pile.forEach(tk => { tk.hold = true; });
      announce(pile.length + ' task' + (pile.length !== 1 ? 's' : '') + ' added to your list, waiting to be placed');
    } else announce('Added from your assistant');
    aiOpen = false; aiPreview = null; aiStep = 'input'; aiError = ''; clearDraft('ai_paste');
    view = 'day';
    save(); render();
  }

  function aiPreviewHTML(){
    const p = aiPreview;
    const grp = (label, rows) => rows.length ? '<div class="ai-group"><div class="ai-glabel">'+label+'</div>'+rows.join('')+'</div>' : '';
    const niceBy = k => { const x = parseDay(k); return x.getDate()+' '+SHORT[x.getMonth()]; };
    let h = '';
    h += grp(p.events.length+' event'+(p.events.length !== 1 ? 's' : ''), p.events.map(e =>
      '<div class="ai-row"><span class="cd" style="background:'+catColor(e.cat)+'"></span>'+
      '<span class="pt">'+esc(e.title)+(e.note ? '<small>'+esc(e.note)+'</small>' : '')+'</span>'+
      '<span class="when">'+esc(aiWhen(e))+'</span></div>'));
    // Tasks get a category you can change before anything lands, because the
    // category decides which blocks a task goes into, and a wrong one sends it
    // somewhere it does not belong. Anything Athena had to guess is marked.
    const tks = p.tasks || [];
    if (tks.length){
      const opts = sel => S.categories.map(c =>
        '<option value="'+c.id+'"'+(c.id === sel ? ' selected' : '')+'>'+esc(c.label)+'</option>').join('');
      const guessed = tks.filter(x => x.catGuessed).length;
      const total = totalMins(tks);
      let g = '<div class="ai-group"><div class="ai-glabel"><span>'+tks.length+' task'+(tks.length !== 1 ? 's' : '')+
        (total ? ' · '+dur(total) : '')+'</span>'+
        (tks.length > 1 ? '<label class="ai-setall">All to <select data-aicatall><option value="">choose</option>'+opts('')+'</select></label>' : '')+
        '</div>';
      if (guessed)
        g += '<p class="ai-guess">'+(guessed === tks.length
          ? 'None of these came back with a category you use, so Athena guessed.'
          : guessed+' of these came back without a category you use, so Athena guessed. They are marked.')+
          ' Worth a check before they land.</p>';
      g += tks.map((x, i) => '<div class="ai-row ai-trow'+(x.catGuessed ? ' guessed' : '')+'">'+
        '<span class="cd" style="background:'+catColor(x.cat)+'"></span>'+
        '<span class="pt">'+esc(x.title)+
          '<small>'+esc((x.due ? (x.dateType === 'on' ? 'on ' : 'by ')+niceBy(x.due) : (x.repeat ? repeatLabel(x.repeat) : 'anytime')) +
          (x.mins ? ' · '+dur(x.mins) : ' · no estimate')+(x.priority === 'high' ? ' · high priority' : ''))+'</small></span>'+
        '<select class="ai-cat" data-aicat="'+i+'" aria-label="Category for '+esc(x.title)+'">'+opts(x.cat)+'</select></div>').join('');
      h += g + '</div>';
    }
    h += grp(p.habits.length+' habit'+(p.habits.length !== 1 ? 's' : ''), p.habits.map(x =>
      '<div class="ai-row"><span class="cd" style="background:'+catColor(x.cat)+'"></span>'+
      '<span class="pt">'+esc(x.label)+'</span><span class="when">'+(x.target > 1 ? x.target+'× daily' : 'daily')+'</span></div>'));
    h += grp(p.goals.length+' goal'+(p.goals.length !== 1 ? 's' : ''), p.goals.map(g =>
      '<div class="ai-row"><span class="cd" style="background:'+catColor(g.cat)+'"></span>'+
      '<span class="pt">'+esc(g.title)+(g.steps.length ? '<small>'+g.steps.length+' step'+(g.steps.length !== 1 ? 's' : '')+'</small>' : '')+'</span>'+
      '<span class="when">'+(g.by ? 'by '+niceBy(g.by) : 'no date')+'</span></div>'));
    return h;
  }

  // Athena's own assistant: send the request to /api/ai and go straight to the
  // preview. Falls back to the manual flow if it is unavailable.
  let aiBusy = false, aiManual = false;
  async function aiAskAthena(){
    const ask = (((document.getElementById('ai_ask') || {}).value) || '').trim();
    if (!ask){ const i = document.getElementById('ai_ask'); if (i) i.focus(); return; }
    if (!cloud || !session){ aiError = 'Sign in first to use the built-in assistant.'; render(); return; }
    aiBusy = true; aiError = ''; render();
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : '';
      const r = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          ask: ask,
          categories: S.categories.map(c => c.label).join(', '),
          today: dayKey(new Date())
        })
      });
      let j = {};
      try { j = await r.json(); } catch(_){}
      aiBusy = false;
      if (!r.ok){
        aiError = (j && j.error) || 'That did not work. Try again, or use your own assistant below.';
        render(); return;
      }
      aiBuildPreview(j.text);
    } catch(e){
      aiBusy = false;
      aiError = 'Could not reach the assistant. Check your connection, or use your own assistant below.';
      render();
    }
  }

  // Open the user's assistant with the whole prompt (schema plus their request)
  // already filled in, so they never have to copy anything on the way out.
  function aiLaunch(which){
    const ask = ((document.getElementById('ai_ask') || {}).value || '').trim();
    const full = aiPrompt() + ask;
    const enc = encodeURIComponent(full);
    const url = which === 'claude'
      ? 'https://claude.ai/new?q=' + enc
      : 'https://chatgpt.com/?q=' + enc;
    if (S.profile){ S.profile.preferredAI = which; save(); }   // remember for next time
    try { window.open(url, '_blank', 'noopener'); }
    catch(_){ aiError = 'Could not open your assistant. Copy the prompt instead.'; render(); }
  }
  // Read the reply straight off the clipboard and go straight to the preview.
  async function aiPasteClip(){
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt || !txt.trim()){ aiError = 'The clipboard looks empty. Copy your assistant\'s reply first.'; render(); return; }
      const ta = document.getElementById('ai_paste');
      if (ta) ta.value = txt;
      drafts['ai_paste'] = txt;
      aiBuildPreview();
    } catch(e){
      aiError = 'This browser wouldn\'t let me read the clipboard. Paste into the box instead.';
      render();
    }
  }

  function aiHTML(){
    let h = '<div class="modal-back" data-aiclose></div><div class="modal"><div class="modal-h">Ask your AI</div>';
    if (aiStep === 'preview' && aiPreview){
      h += '<p class="ai-intro">Here\'s what your assistant suggests. Nothing is added until you tap the button.</p>';
      h += aiPreviewHTML();
      // With tasks to place, the choice matters, so it is asked rather than
      // assumed: fill the blocks by length, or keep them out until placed.
      const pile = (aiPreview.tasks || []).filter(placeable);
      if (pile.length)
        h += '<p class="ai-howto"><b>Place them for me</b> puts each task in the earliest block of its category with room for it, '+
          'most urgent first, and moves on to the next block when one is full. <b>Add to my list</b> keeps them out of your blocks '+
          'until you place them yourself.</p>';
      h += '<div class="modal-actions"><button class="ghost" data-aiback>Back</button><span style="flex:1"></span>'+
        (pile.length
          ? '<button class="ghost" data-aiapply="list">Add to my list</button><button class="go" data-aiapply="place">Place them for me</button>'
          : '<button class="go" data-aiapply="">Add to my week</button>')+'</div>';
    } else {
      h += '<p class="ai-intro">Say it in plain words. Athena sorts it into events, tasks, habits and goals for you to approve.</p>';
      h += '<label class="fld"><span>What should Athena add?</span>'+
        '<textarea id="ai_ask" rows="3" placeholder="e.g. chase the invoice, book the dentist, and a weekly SEO check on Fridays"></textarea></label>';
      h += '<button class="go ai-primary" data-aiask'+(aiBusy ? ' disabled' : '')+'>'+
        (aiBusy ? 'Thinking…' : 'Ask Athena')+'</button>';
      if (aiError) h += '<p class="ai-error">'+esc(aiError)+'</p>';

      h += '<button class="linkish ai-alt" data-aimanual>'+
        (aiManual ? 'Hide the manual way' : 'Or use your own assistant')+'</button>';
      if (aiManual){
        const pref = (S.profile && S.profile.preferredAI) || 'chatgpt';
        const launch = [['chatgpt','ChatGPT'], ['claude','Claude']];
        launch.sort((a,b) => (a[0] === pref ? -1 : 0) - (b[0] === pref ? -1 : 0));
        h += '<div class="ai-manual">';
        h += '<div class="ai-launch">' + launch.map((l,i) =>
          '<button class="'+(i===0?'go':'ghost')+'" data-ailaunch="'+l[0]+'">Open in '+l[1]+'</button>').join('') + '</div>';
        h += '<button class="linkish ai-alt" data-aicopy>Using something else? Copy the prompt</button>';
        h += '<label class="fld"><span>Then paste the reply back</span>'+
          '<textarea id="ai_paste" rows="4" placeholder="Paste what your assistant gave you…"></textarea></label>';
        h += '<button class="ghost ai-clip" data-aipasteclip>Paste from clipboard and preview</button>';
        h += '<div class="modal-actions" style="margin-top:10px"><span style="flex:1"></span><button class="go" data-aipreview>Preview</button></div>';
        h += '</div>';
      }
      h += '<div class="modal-actions"><button class="ghost" data-aiclose>Cancel</button><span style="flex:1"></span></div>';
    }
    h += '</div>';
    return h;
  }

  /* ==========================================================================
     Events / interaction
     ========================================================================== */

  // ----- desktop drag in the expanded grid: resize + vertical (time) move -----
  const GH = 680, GSPAN = SPAN, GORDER = [1,2,3,4,5,6,0];
  /* ---- moving and resizing on the day grid ----
     The week grid has had this all along; the day grid was read-only for shape,
     which made it the odd one out. Same idea, simpler geometry: one column, so
     only the time changes, never the day.

     A repeating block is changed for this day only, exactly as the week does
     it. Nudging Tuesday's focus block later should not move every Tuesday for
     the rest of the year. */
  let ddrag = null;
  const snap15 = m => Math.round(m / 15) * 15;

  app.addEventListener('pointerdown', e => {
    if (view !== 'day' || weekShown() || editing || aiOpen || noteEdit || taskEdit || ob) return;
    const el = e.target.closest && e.target.closest('.dblk');
    if (!el || e.target.closest('.dtick')) return;      // ticking is not dragging
    // A finger on a block is usually a finger scrolling the day. On a touch
    // screen a block only moves once it has been tapped and outlined; every
    // other block lets the page scroll. A mouse cannot be mistaken for a
    // scroll, so it moves any block straight away.
    if (e.pointerType === 'touch' && !el.classList.contains('picked')) return;
    const col = app.querySelector('.dcol'); if (!col) return;
    const vd = viewDate();
    const b = blocksForDate(vd).find(x => String(x.uid || x.id) === el.dataset.blockid);
    if (!b || b.step) return;                           // a goal step is not yours to move here
    e.preventDefault();
    ddrag = {
      el: el, b: b, dk: dayKey(vd), y0: e.clientY,
      s: mins(b.s), e: mins(b.e), h: col.getBoundingClientRect().height,
      resize: !!(e.target.classList && e.target.classList.contains('drz')),
      moved: false
    };
    ddrag.newS = ddrag.s; ddrag.newE = ddrag.e;
    // The pointer is only captured once this turns out to be a move. Capturing
    // it on the press re-aims the click at the block's outer box, where nothing
    // listens, and that is how clicking a block quietly stopped opening it.
    ddrag.pid = e.pointerId;
  });

  app.addEventListener('pointermove', e => {
    if (!ddrag) return;
    const dy = e.clientY - ddrag.y0;
    if (!ddrag.moved && Math.abs(dy) < 4) return;
    if (!ddrag.moved){ try { ddrag.el.setPointerCapture(ddrag.pid); } catch(_){} }
    ddrag.moved = true;
    const dm = snap15(dy / ddrag.h * SPAN);
    if (ddrag.resize){
      ddrag.newE = Math.min(DE, Math.max(ddrag.s + 15, ddrag.e + dm));
    } else {
      const len = ddrag.e - ddrag.s;
      ddrag.newS = Math.min(DE - len, Math.max(DS, ddrag.s + dm));
      ddrag.newE = ddrag.newS + len;
    }
    const px = m => (m - DS) / SPAN * ddrag.h;
    ddrag.el.style.top = px(ddrag.newS) + 'px';
    ddrag.el.style.height = Math.max(22, px(ddrag.newE) - px(ddrag.newS) - 2) + 'px';
    ddrag.el.classList.add('dragging');
  });

  app.addEventListener('pointerup', () => {
    if (!ddrag) return;
    const d = ddrag; ddrag = null;
    if (!d.moved) return;
    const s = fmtM(d.newS), en = fmtM(d.newE);
    const b = d.b;
    if (b.task){
      // An appointment is a task with a time, so moving it is setting that time.
      const tk = findTask(b.task.id);
      if (tk){ tk.at = s; tk.mins = Math.max(5, d.newE - d.newS); }
    } else if (b.routine){
      const r = routinesAll().find(x => x.id === b.routine.id);
      if (r) r.time = s;
    } else {
      const ev = findEvent(b.id);
      // This day only, like the week grid. A nudge is not a decision about
      // every other Tuesday.
      if (ev){ ev.ex = ev.ex || {}; ev.ex[d.dk] = Object.assign({}, ev.ex[d.dk], { start: s, end: en }); }
    }
    noClick = true; save(); render();
  });
  // If the browser takes the gesture back (a scroll after all), put the block
  // back where it was rather than leave it stranded half way.
  app.addEventListener('pointercancel', () => { if (ddrag){ ddrag = null; render(); } });

  let drag = null, noClick = false;
  app.addEventListener('pointerdown', e => {
    // weekShown(), not view === 'week'. The week lives inside the Day tab now,
    // and this check quietly stopped matching when that changed, which killed
    // dragging in the week grid with nothing to say so.
    if (!weekShown() || !expanded || editing || aiOpen) return;
    // On a touch screen the week is for looking and scrolling. Blocks here are
    // small enough that a scroll would move one nearly every time, and tapping
    // one opens it, where its time can be changed properly.
    if (e.pointerType === 'touch') return;
    const cb = e.target.closest('.cb'); if (!cb) return;
    if (cb.classList.contains('cbstep')) return; // goal-step blocks aren't draggable
    const cols = app.querySelector('.calcols'); if (!cols) return;
    e.preventDefault();
    drag = {
      el: cb, uid: cb.dataset.uid, dk: cb.dataset.dk,
      s: +cb.dataset.sm, e: +cb.dataset.em, pos: +cb.dataset.pos,
      x: e.clientX, y: e.clientY,
      cols: (cols.dataset.dates || '').split(',').filter(Boolean),
      colW: (() => { const list = (cols.dataset.dates||'').split(',').filter(Boolean);
        const count = list.length || 7;
        return (cols.clientWidth - 6 * (count - 1)) / count + 6; })(),
      resize: e.target.classList.contains('rz'), moved: false
    };
    drag.newS = drag.s; drag.newE = drag.e; drag.newPos = drag.pos;
    cb.setPointerCapture(e.pointerId);
  });
  app.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    if (!drag.moved){ drag.moved = true; drag.el.classList.add('dragging'); }
    const pxMin = GH / GSPAN;
    const dm = Math.round((dy / pxMin) / 15) * 15;
    if (drag.resize){
      drag.newE = Math.min(DS + GSPAN, Math.max(drag.s + 15, drag.e + dm));
      drag.el.style.height = Math.max(20, (drag.newE - drag.s) * pxMin - 2) + 'px';
    } else {
      const len = drag.e - drag.s;
      const last = Math.max(0, (drag.cols.length || 7) - 1);
      drag.newPos = Math.max(0, Math.min(last, drag.pos + Math.round(dx / drag.colW)));
      drag.newS = Math.max(DS, Math.min(DS + GSPAN - len, drag.s + dm));
      drag.newE = drag.newS + len;
      drag.el.style.transform = 'translate(' + ((drag.newPos - drag.pos) * drag.colW) + 'px,' +
        ((drag.newS - drag.s) * pxMin) + 'px)';
    }
  });
  app.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.moved){
      const ev = findEvent(drag.uid);
      if (ev){
        const s = fmtM(drag.newS), en = fmtM(drag.newE);
        if (drag.resize || drag.newPos === drag.pos){
          // same day — just override this occurrence's time
          ev.ex = ev.ex || {}; ev.ex[drag.dk] = Object.assign({}, ev.ex[drag.dk], { start:s, end:en });
        } else {
          // moved to another day
          const newDk = drag.cols[drag.newPos];
          if (!newDk){ noClick = true; drag = null; render(); return; }
          if (!ev.rrule){
            ev.date = newDk; ev.start = s; ev.end = en;
            if (ev.ex) delete ev.ex[drag.dk];
          } else {
            // detach just this occurrence: skip it in the series, drop a one-off on the new day
            ev.skip = ev.skip || []; if (ev.skip.indexOf(drag.dk) === -1) ev.skip.push(drag.dk);
            S.events.push({ id:'ev_'+uid8(), title:ev.title, note:ev.note, cat:ev.cat,
              allDay:false, start:s, end:en, rrule:null, date:newDk, ex:{}, skip:[] });
          }
        }
      }
      noClick = true; save(); drag = null; render(); return;
    }
    drag = null;
  });

  // Swipe left/right on the Day view to step through days (phones).
  let swX = null, swY = null;
  app.addEventListener('touchstart', e => {
    const swipeable = (view === 'day');
    // Not from a picked block either: that finger is moving the block, and a
    // sideways wobble while doing it should not flip to another day.
    if (!swipeable || editing || settingsOpen || aiOpen || ob || taskEdit || e.touches.length !== 1 ||
        (e.target.closest && e.target.closest('.dblk.picked'))){ swX = null; return; }
    swX = e.touches[0].clientX; swY = e.touches[0].clientY;
  }, { passive: true });
  app.addEventListener('touchend', e => {
    if (swX == null) return;
    const tp = e.changedTouches && e.changedTouches[0];
    const x = swX, y = swY; swX = null;
    if (!tp) return;
    const dx = tp.clientX - x, dy = tp.clientY - y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45){
      const step = weekShown() ? (phoneGrid() ? 3 : 7) : 1;
      dayShift += (dx < 0 ? step : -step);   // swipe left = forwards
      noClick = true;                  // swallow the click this gesture would fire
      render();
    }
  }, { passive: true });

  shell.addEventListener('click', e => {
    if (noClick){ noClick = false; e.preventDefault(); return; }
    const now = new Date(), today = dayKey(now);
    const t = el => e.target.closest(el);
    let m;

    // auth
    if (t('[data-sendcode]')){ sendCode(); return; }
    if (t('[data-verifycode]')){ verifyCode(); return; }
    if (t('[data-authback]')){ authStep = 'email'; authMsg = ''; renderAuth(); return; }
    if (t('[data-signout]')){ if (sb) sb.auth.signOut().catch(()=>{}); settingsOpen = false; return; }
    if (t('[data-export]')){ exportBackup(); return; }
    if (t('[data-forceupdate]')){ forceUpdate(); return; }

    // onboarding
    // A first run ends on the explainer (step 4) and builds. A rerun skips the
    // explainer, having read it once, and ends on the review (step 5).
    if (t('[data-obrerun]')){ obStartRerun(); return; }
    if (t('[data-obnext]')){
      obSync();
      if (ob.rerun && ob.step === 3){ obReview(); return; }
      ob.step = Math.min(4, ob.step + 1); render(); return;
    }
    if (t('[data-obback]')){ obSync(); ob.step = ob.step === 5 ? 3 : Math.max(0, ob.step - 1); render(); return; }
    if ((m = t('[data-obcat]'))){
      obSync(); const id = m.dataset.obcat; const i = ob.cats.indexOf(id);
      if (i === -1){ ob.cats.push(id); if (!ob.plan[id]) ob.plan[id] = obPlanDefault(id); }
      else ob.cats.splice(i, 1);
      render(); return;
    }
    if (t('[data-obaddcat]')){ obAddCustom(); return; }
    if ((m = t('[data-obtoggle]'))){ const i = m.dataset.obtoggle; ob.skip[i] = !ob.skip[i]; render(); return; }
    if (t('[data-obapply]')){ obApply(); return; }
    if (t('[data-obcancel]')){ ob = null; render(); return; }
    if (t('[data-obfinish]')){ obFinish(); return; }
    if (t('[data-obskip]')){ obSkip(); return; }

    // ask your AI
    if (t('[data-aiopen]')){ aiOpen = true; aiStep = 'input'; aiPreview = null; aiError = ''; clearDraft('ai_paste'); clearDraft('ai_ask'); render(); return; }
    if (t('[data-aiclose]')){ aiOpen = false; aiPreview = null; aiStep = 'input'; aiError = ''; clearDraft('ai_paste'); clearDraft('ai_ask'); render(); return; }
    if (t('[data-aiask]')){ aiAskAthena(); return; }
    if (t('[data-aimanual]')){ aiManual = !aiManual; aiError = ''; render(); return; }
    if ((m = t('[data-ailaunch]'))){ aiLaunch(m.dataset.ailaunch); return; }
    if (t('[data-aipasteclip]')){ aiPasteClip(); return; }
    if (t('[data-aipreview]')){ aiBuildPreview(); return; }
    if (t('[data-aiback]')){ aiStep = 'input'; aiError = ''; render(); return; }
    if (t('[data-aicat], [data-aicatall]')) return;     // selects: handled on change
    if ((m = t('[data-aiapply]'))){ aiApply(m.dataset.aiapply || ''); return; }
    if ((m = t('[data-spread]'))){
      const vd = viewDate();
      const b = blocksForDate(vd).find(x => String(x.uid || x.id) === m.dataset.spread);
      if (!b) return;
      // What this block is offering right now, minus anything already put here
      // by hand, which stays exactly where it was put.
      const homes = upcomingHomes(vd);
      const pool = tasksForBlock(b, vd).filter(tk =>
        !pinnedTo(tk, b, vd) && placeable(tk) && taskIsSoon(tk, vd, homes));
      markUndo('Spreading');
      announce(placedSummary(placeByCapacity(pool, vd)));
      save(); render(); return;
    }
    if (t('[data-placeheld]')){
      const pool = (S.tasks || []).filter(tk => tk.hold && placeable(tk));
      markUndo('Placing');
      announce(placedSummary(placeByCapacity(pool, new Date())));
      save(); render(); return;
    }
    if ((m = t('[data-aicopy]'))){
      const txt = aiPrompt();
      const done = () => { m.textContent = 'Copied ✓'; setTimeout(() => { if (m) m.textContent = 'Copy prompt'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, done); else done();
      return;
    }

    // editor / settings dismissal
    if (t('[data-closeeditor]')){ editing = null; clearModalDrafts(); render(); return; }
    if (t('[data-saveevent]')){ commitEvent(); return; }
    if (t('[data-retryload]')){ load().then(() => { applyTheme(); render(); }); return; }
    if (t('[data-worklocal]')){ workLocal = true; applyTheme(); render(); return; }
    if (t('[data-undo]')){ doUndo(); return; }

    // tasks
    if (t('[data-closetask]')){ taskEdit = null; clearModalDrafts(); render(); return; }
    if (t('[data-savetask]')){ commitTask(); return; }
    if ((m = t('[data-taskedit]'))){ openTaskEditor(m.dataset.taskedit); return; }
    if ((m = t('[data-tasktoggle]'))){
      const [id, dk2] = m.dataset.tasktoggle.split('|');
      const tk = findTask(id);
      if (tk){
        const ref = dk2 ? parseDay(dk2) : now;
        toggleTask(tk, ref);
        if (taskDone(tk, ref)){ markJustDone(id); buzz(12); }
      }
      save(); render(); return;
    }
    if ((m = t('[data-deltask]'))){
      markUndo('Task deleted');
      S.tasks = (S.tasks || []).filter(x => x.id !== m.dataset.deltask);
      taskEdit = null; clearModalDrafts(); save(); render(); return;
    }
    if ((m = t('[data-blocktasks]'))){ openBlockTasks = (openBlockTasks === m.dataset.blocktasks) ? null : m.dataset.blocktasks; render(); return; }
    if ((m = t('[data-blocklater]'))){ openBlockLater = (openBlockLater === m.dataset.blocklater) ? null : m.dataset.blocklater; render(); return; }
    if (t('[data-toggledone]')){ showDone = !showDone; render(); return; }
    if (t('[data-addtask]')){
      const ti = (document.getElementById('tk_title') || {}).value || '';
      if (!ti.trim()) return;
      const rep = (document.getElementById('tk_rep') || {}).value || 'once';
      S.tasks = S.tasks || [];
      const nt = {
        id: 'tk_'+uid8(), title: ti.trim().slice(0,140), note: '',
        cat: (document.getElementById('tk_cat') || {}).value || (S.categories[0]||{}).id,
        priority: (document.getElementById('tk_prio') || {}).value || 'normal',
        due: (document.getElementById('tk_due') || {}).value || null,
        dateType: (document.getElementById('tk_when') || {}).value || 'by',
        mins: +((document.getElementById('tk_mins') || {}).value || 0) || null,
        repeat: rep === 'once' ? null : { freq: rep, interval: 1 },
        at: null, createdAt: new Date().toISOString(), doneAt: null
      };
      nt.at = normaliseAt((document.getElementById('tk_at') || {}).value, nt);
      S.tasks.push(nt);
      clearDraft('tk_title'); clearDraft('tk_due'); clearDraft('tk_at');
      save(); render();
      const i = document.getElementById('tk_title'); if (i) i.focus();   // keep dumping
      return;
    }
    if ((m = t('[data-delevent]'))){ markUndo('Event deleted'); S.events = S.events.filter(x => x.id !== m.dataset.delevent); editing = null; clearModalDrafts(); save(); render(); return; }
    if ((m = t('[data-wd]'))){ syncEditor(); const d = +m.dataset.wd; const i = editing.weekdays.indexOf(d); if (i===-1) editing.weekdays.push(d); else editing.weekdays.splice(i,1); render(); return; }
    if ((m = t('[data-settheme]'))){ commitSettings(); S.profile.theme = m.dataset.settheme; applyTheme(); save(); render(); return; }
    if (t('[data-settings]')){ clearModalDrafts(); settingsOpen = true; render(); return; }
    if (t('[data-closesettings]')){ commitSettings(); settingsOpen = false; clearModalDrafts(); render(); return; }
    if (t('[data-addcat]')){ commitSettings(); S.categories.push({ id:'c_'+uid8(), label:'New', color:'#B7B2BE' }); save(); render(); return; }
    if ((m = t('[data-delcat]'))){ commitSettings(); if (S.categories.length>1){ markUndo('Category removed'); S.categories = S.categories.filter(c=>c.id!==m.dataset.delcat); } save(); render(); return; }

    // re-render editor when repeat/all-day changes handled in 'change' listener below

    if ((m = t('[data-editinst]'))){ const [id, dk] = m.dataset.editinst.split('|'); openEditor({ id, date: dk }); return; }
    if ((m = t('[data-gotogoal]'))){ view = 'grow'; growMode = 'goals'; openGoal = m.dataset.gotogoal; render(); return; }
    // "New event here" sits on the whole column, so it catches every click
    // inside it, including the controls on the blocks drawn on top of it.
    // Anything within a block belongs to that block and has to fall through to
    // its own handler further down. This pattern has now bitten three times.
    if ((m = t('[data-newon]')) && !e.target.closest('.dblk, .cb, .adchip')){
      openEditor({ date: m.dataset.newon }); return;
    }

    if ((m = t('[data-view]'))){ view = m.dataset.view; openDay = null; render(); return; }
    if ((m = t('[data-shift]'))){ dayShift += +m.dataset.shift; openDay = null; render(); return; }
    if (t('[data-today]')){ dayShift = 0; openDay = null; render(); return; }
    if ((m = t('[data-daymode]'))){ dayMode = m.dataset.daymode; openDay = null; render(); return; }
    if ((m = t('[data-growmode]'))){ growMode = m.dataset.growmode; openGoal = null; render(); return; }

    // ---- routines ----
    if ((m = t('[data-gotoroutine]'))){ view = 'grow'; growMode = 'routines'; render(); return; }
    if (t('[data-addroutine]')){
      const nm = ((document.getElementById('ro_name') || {}).value || '').trim();
      if (!nm){ const i = document.getElementById('ro_name'); if (i) i.focus(); return; }
      const days = (document.getElementById('ro_days') || {}).value || 'wd';
      S.routines = routinesAll().concat([{
        id: 'ro_' + uid8(), name: nm.slice(0, 60),
        time: (document.getElementById('ro_time') || {}).value || '07:00',
        weekdays: days === 'all' ? [0,1,2,3,4,5,6] : days === 'we' ? [0,6] : [1,2,3,4,5],
        cat: (S.categories[0] || {}).id, habits: []
      }]);
      clearDraft('ro_name'); save(); render(); return;
    }
    if ((m = t('[data-delroutine]'))){
      // The habits themselves are not the routine's to delete: they go back to
      // being loose, with their history intact.
      markUndo('Routine removed');
      S.routines = routinesAll().filter(r => r.id !== m.dataset.delroutine);
      save(); render(); return;
    }
    if ((m = t('[data-rwd]'))){
      const parts = m.dataset.rwd.split(':'), r = routinesAll().find(x => x.id === parts[0]), d = +parts[1];
      if (r){
        const wd = (r.weekdays || []).slice();
        const i = wd.indexOf(d);
        if (i === -1) wd.push(d); else wd.splice(i, 1);
        r.weekdays = wd.sort();
        save(); render();
      }
      return;
    }
    if ((m = t('[data-raddnew]'))){
      const rid = m.dataset.raddnew, r = routinesAll().find(x => x.id === rid);
      const i = document.getElementById('rnew_' + rid);
      const v = ((i && i.value) || '').trim();
      if (!r || !v){ if (i) i.focus(); return; }
      const hb = { id: 'hb_' + uid8(), label: v.slice(0, 80), cat: r.cat || (S.categories[0] || {}).id, target: 1 };
      S.habits = (S.habits || []).concat([hb]);
      r.habits = (r.habits || []).concat([hb.id]);
      clearDraft('rnew_' + rid); save(); render();
      const f = document.getElementById('rnew_' + rid); if (f) f.focus();
      return;
    }
    if ((m = t('[data-raddexisting]'))){
      const rid = m.dataset.raddexisting, r = routinesAll().find(x => x.id === rid);
      const sel = document.getElementById('rpick_' + rid);
      const id = (sel && sel.value) || '';
      if (r && id && (r.habits || []).indexOf(id) === -1){ r.habits = (r.habits || []).concat([id]); save(); render(); }
      return;
    }
    if ((m = t('[data-rout]'))){
      const parts = m.dataset.rout.split(':'), r = routinesAll().find(x => x.id === parts[0]);
      if (r){ r.habits = (r.habits || []).filter(id => id !== parts[1]); save(); render(); }
      return;
    }
    if ((m = t('[data-rup]')) || (m = t('[data-rdown]'))){
      const up = !!m.dataset.rup;
      const parts = (m.dataset.rup || m.dataset.rdown).split(':');
      const r = routinesAll().find(x => x.id === parts[0]);
      if (r){
        const ids = (r.habits || []).slice(), i = ids.indexOf(parts[1]), j = up ? i - 1 : i + 1;
        if (i !== -1 && j >= 0 && j < ids.length){ const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; r.habits = ids; save(); render(); }
      }
      return;
    }
    if ((m = t('[data-routinedone]'))){
      // Tapping the routine itself is "I did the whole thing", which is how
      // people actually think about a morning routine they got through.
      const parts = m.dataset.routinedone.split('|');
      const r = routinesAll().find(x => x.id === parts[0]);
      if (r){
        const hs = routineHabits(r), dk2 = parts[1];
        const p = routineProgress(r, parseDay(dk2));
        const all = p.total > 0 && p.done === p.total;
        hs.forEach(hb => {
          const on = isDone(hb.id, dk2, hb.target);
          if (all && on){ const mm = S.completions[dk2]; if (mm){ delete mm[hb.id]; if (!Object.keys(mm).length) delete S.completions[dk2]; } }
          else if (!all && !on){ const mm = S.completions[dk2] || (S.completions[dk2] = {}); mm[hb.id] = hb.target ? hb.target : true; }
        });
        if (!all) markJustDone(r.id);
        save(); render(); maybeCelebrate();
      }
      return;
    }

    // ---- notes ----
    if (t('[data-notequick]')){
      const i = document.getElementById('nt_quick');
      const v = ((i && i.value) || '').trim();
      if (!v) { if (i) i.focus(); return; }
      const n = newNote('text'); n.title = v.slice(0, 140);
      clearDraft('nt_quick'); save(); render();
      const f = document.getElementById('nt_quick'); if (f) f.focus();   // keep capturing
      return;
    }
    if ((m = t('[data-notenew]'))){
      const i = document.getElementById('nt_quick');
      const v = ((i && i.value) || '').trim();
      const n = newNote(m.dataset.notenew);
      if (v) n.title = v.slice(0, 140);
      clearDraft('nt_quick');
      noteEdit = n; save(); render(); return;
    }
    // Starting from a photo, which is how anyone with a picture in their hand
    // actually thinks about it. Making them invent a note first was a hop too
    // many, and hid the feature behind a step nobody would guess at.
    if (t('[data-notephoto]')){
      if (!cloud || !session){ alert('Photos need an account, so they are stored safely and reach your other devices. Sign in first.'); return; }
      const i = document.getElementById('nt_quick');
      const v = ((i && i.value) || '').trim();
      const n = newNote('text');
      if (v) n.title = v.slice(0, 140);
      clearDraft('nt_quick');
      noteEdit = n; save(); render();
      // Still inside the tap that got us here, so the picker is allowed to open.
      const f = document.getElementById('ne_file'); if (f) f.click();
      return;
    }
    if ((m = t('[data-notepin]'))){
      const n = findNote(m.dataset.notepin);
      if (n){ n.pinned = !n.pinned; touchNote(n); if (noteEdit) noteSync(); save(); render(); }
      return;
    }
    if ((m = t('[data-noteitem]'))){
      const parts = m.dataset.noteitem.split(':');
      const n = findNote(parts[0]);
      const it = n && (n.items || []).find(x => x.id === parts[1]);
      if (it){ if (noteEdit) noteSync(); it.done = !it.done; touchNote(n); save(); render(); }
      return;
    }
    if ((m = t('[data-noteopen]'))){ noteEdit = findNote(m.dataset.noteopen) || null; imgError = ''; render(); return; }
    if ((m = t('[data-notecolor]'))){ noteSync(); noteEdit.color = m.dataset.notecolor; render(); return; }
    if (t('[data-noteadditem]')){
      noteSync();
      const i = document.getElementById('ne_newitem');
      const v = ((i && i.value) || '').trim();
      if (v){ noteEdit.items = (noteEdit.items || []).concat([{ id:'ni_'+uid8(), text:v.slice(0,200), done:false }]); }
      clearDraft('ne_newitem'); render();
      const f = document.getElementById('ne_newitem'); if (f) f.focus();
      return;
    }
    if ((m = t('[data-noteimgdel]'))){
      noteSync();
      const parts = m.dataset.noteimgdel.split(':');
      const n = findNote(parts[0]);
      if (n) removeNoteImage(n, parts[1]);
      return;
    }
    if ((m = t('[data-noteitemdel]'))){
      noteSync();
      noteEdit.items = (noteEdit.items || []).filter(x => x.id !== m.dataset.noteitemdel);
      render(); return;
    }
    if ((m = t('[data-notetolist]'))){
      // Each line becomes an item, so a note jotted as a list actually becomes one.
      noteSync();
      const lines = String(noteEdit.body || '').split('\n').map(s => s.trim()).filter(Boolean);
      noteEdit.items = (noteEdit.items || []).concat(lines.map(s => ({ id:'ni_'+uid8(), text:s.slice(0,200), done:false })));
      noteEdit.body = ''; noteEdit.kind = 'list'; render(); return;
    }
    if ((m = t('[data-notetotext]'))){
      noteSync();
      const lines = (noteEdit.items || []).map(i => i.text);
      noteEdit.body = (String(noteEdit.body || '') + (noteEdit.body ? '\n' : '') + lines.join('\n')).slice(0, 8000);
      noteEdit.items = []; noteEdit.kind = 'text'; render(); return;
    }
    if ((m = t('[data-notearchive]'))){
      noteSync();
      const n = findNote(m.dataset.notearchive);
      if (n){ n.archived = !n.archived; if (n.archived) n.pinned = false; touchNote(n); }
      noteEdit = null; imgError = ''; clearModalDrafts(); save(); render(); return;
    }
    if ((m = t('[data-notedelete]'))){
      const gone = findNote(m.dataset.notedelete);
      const paths = gone ? (gone.images || []).map(x => x.path) : [];
      markUndo('Note deleted');
      S.notes = notesAll().filter(n => n.id !== m.dataset.notedelete);
      noteEdit = null; clearModalDrafts(); save(); render();
      // Undo puts the note back but not the files, so the photos stay put for a
      // moment. The undo bar times out; sweep them then.
      if (paths.length) setTimeout(() => {
        if (notesAll().some(n => n.id === m.dataset.notedelete)) return;   // undone
        if (cloud && session) sb.storage.from('note-images').remove(paths).catch(() => {});
      }, 12000);
      return;
    }
    if (t('[data-notesave]')){
      noteSync();
      const n = noteEdit;
      // An untouched blank note is a slip, not a thing to keep. A photo counts.
      if (n && noteIsBlank(n)) S.notes = notesAll().filter(x => x.id !== n.id);
      else if (n) touchNote(n);
      noteEdit = null; imgError = ''; clearModalDrafts(); save(); render(); return;
    }
    if (t('[data-notecancel]')){
      const n = noteEdit;
      if (n && noteIsBlank(n)) S.notes = notesAll().filter(x => x.id !== n.id);
      noteEdit = null; imgError = ''; clearModalDrafts(); save(); render(); return;
    }
    if (t('[data-notearchiveview]')){ notesArchived = !notesArchived; noteSearch = ''; render(); return; }
    if ((m = t('[data-notemaketask]'))){
      noteSync();
      const n = findNote(m.dataset.notemaketask);
      const titles = n ? noteToTasks(n) : [];
      if (!titles.length) return;
      markUndo(titles.length === 1 ? 'Task made from a note' : titles.length + ' tasks made from a note');
      const stamp = new Date().toISOString();
      S.tasks = (S.tasks || []).concat(titles.map(title => ({
        id: 'tk_' + uid8(), title: title, note: '',
        cat: n.cat || (S.categories[0] || {}).id, priority: 'normal',
        due: null, dateType: 'by', mins: null, repeat: null, at: null,
        createdAt: stamp, doneAt: null
      })));
      noteEdit = null; imgError = ''; clearModalDrafts(); save(); render(); return;
    }
    if ((m = t('[data-notemakeblock]'))){
      noteSync();
      const n = findNote(m.dataset.notemakeblock);
      if (!n) return;
      const head = noteHeadline(n);
      if (!head) return;
      // Hand it to the block editor rather than inventing a time: when a block
      // sits is the whole question, and only the person knows the answer.
      noteEdit = null; clearModalDrafts();
      openEditor({ date: dayKey(viewDate()), title: head, cat: n.cat || undefined,
                   note: n.kind === 'list' ? (n.items || []).map(i => i.text).join(', ').slice(0, 200) : '' });
      return;
    }
    if (t('[data-weekmode]')){ weekMode = (weekMode === 'days' ? 'strips' : 'days'); render(); return; }
    if (t('[data-expand]')){ expanded = !expanded; render(); return; }
    if ((m = t('[data-day]'))){ const d = +m.dataset.day; openDay = (openDay === d) ? null : d; render(); return; }
    if ((m = t('[data-goal]'))){ const id = m.dataset.goal; openGoal = (openGoal === id) ? null : id; render(); return; }

    if ((m = t('[data-done]'))){
      const [id, dk] = m.dataset.done.split('|');
      const on = dk || today;
      toggleDone(id, on);
      if (isDone(id, on)){ markJustDone(id); buzz(12); }
      save(); maybeCelebrate(); render(); return;
    }
    if ((m = t('[data-pip]'))){
      const [id, tg] = m.dataset.pip.split(':');
      bumpCount(id, today, +tg); buzz(10);
      if (isDone(id, today, +tg)) markJustDone(id);
      save(); maybeCelebrate(); render(); return;
    }
    if ((m = t('[data-step]'))){
      const [gid, sid] = m.dataset.step.split(':');
      toggleStep(gid, sid, now); buzz(12);
      const g = S.goals.find(x => x.id === gid), st = g && g.steps.find(s => s.id === sid);
      if (st && stepDone(st, now)) markJustDone(sid);
      save(); maybeCelebrate(); render(); return;
    }
    if ((m = t('[data-stepweek]'))){
      const [ids, dk] = m.dataset.stepweek.split('|');
      const [gid, sid] = ids.split(':');
      const ref = dk ? parseDay(dk) : now;
      toggleStep(gid, sid, ref); buzz(12);
      const g = S.goals.find(x => x.id === gid), st = g && g.steps.find(s => s.id === sid);
      if (st && stepDone(st, ref)) markJustDone(sid);
      save(); maybeCelebrate(); render(); return;
    }

    if (t('[data-addhabit]')){
      const lab = (document.getElementById('hl')||{}).value || '';
      if (!lab.trim()) return;
      clearDraft('hl');
      S.habits.push({ id:'hb_'+uid8(), label:lab.trim().slice(0,80),
        cat:(document.getElementById('hc')||{}).value || (S.categories[0]||{}).id,
        target:+((document.getElementById('hn')||{}).value || 1) });
      save(); render(); return;
    }
    if ((m = t('[data-delhabit]'))){ markUndo('Habit removed'); S.habits = S.habits.filter(x => x.id !== m.dataset.delhabit); save(); render(); return; }

    if (t('[data-addgoal]')){
      const ti = (document.getElementById('gt')||{}).value || '';
      if (!ti.trim()) return;
      clearDraft('gt'); clearDraft('gb');
      const id = 'g_'+uid8();
      S.goals.push({ id, title:ti.trim().slice(0,120), by:(document.getElementById('gb')||{}).value||'',
        cat:(document.getElementById('gc')||{}).value||(S.categories[0]||{}).id, steps:[] });
      openGoal = id; save(); render(); return;
    }
    if ((m = t('[data-addstep]'))){
      const gid = m.dataset.addstep, g = S.goals.find(x=>x.id===gid); if (!g) return;
      const lab = (document.getElementById('sl_'+gid)||{}).value || '';
      if (!lab.trim()) return;
      const freq = (document.getElementById('sf_'+gid)||{}).value || 'weekly';
      clearDraft('sl_'+gid);
      const step = { id:'st_'+uid8(), label:lab.trim().slice(0,120), freq };
      if (freq === 'weekly'){
        step.day  = +((document.getElementById('sday_'+gid)||{}).value || 1);
        step.time = (document.getElementById('stime_'+gid)||{}).value || '17:00';
      }
      g.steps.push(step);
      save(); render(); return;
    }
    if ((m = t('[data-delstep]'))){ markUndo('Step removed'); const [gid, sid] = m.dataset.delstep.split(':'); const g = S.goals.find(x=>x.id===gid); if (g) g.steps = g.steps.filter(s=>s.id!==sid); save(); render(); return; }
    if ((m = t('[data-delgoal]'))){ markUndo('Goal removed'); S.goals = S.goals.filter(x=>x.id!==m.dataset.delgoal); if (openGoal===m.dataset.delgoal) openGoal=null; save(); render(); return; }

    if (t('[data-park]')){ const i = document.getElementById('sk'); const v = i && i.value.trim(); if (!v){ if (i) i.focus(); return; } S.parked.push({ t:v.slice(0,200) }); clearDraft('sk'); save(); render(); const j = document.getElementById('sk'); if (j) j.focus(); return; }
    // Opening a block's detail. An explicit empty string means "closed", which
    // is different from null: null still lets the live block open itself.
    // The whole block is the target, not just its label: a press can also be
    // the start of a move, and the click is not always aimed at the button.
    // Clicking always opens. Closing is the ×, so a second click on a block
    // you are already looking at never makes it vanish.
    if ((m = t('[data-dayblock]')) || ((m = t('.dblk')) && !t('.dtick') && (m = m.querySelector('[data-dayblock]')))){
      openDayBlock = m.dataset.dayblock;
      openBlockLater = null;
      render(); return;
    }
    // The bar a phone shows for a picked block: jump down to what is in it.
    // (Its × is data-dayclose, which puts the block down.)
    if (t('[data-blkjump]')){ const d = app.querySelector('.ddet'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (t('[data-dayclose]')){ openDayBlock = ''; render(); return; }
    if (t('[data-review]')){ reviewOpen = true; render(); return; }
    if (t('[data-reviewclose]')){ reviewOpen = false; render(); return; }
    if ((m = t('[data-addbreak]'))){
      // A break is a block like any other, so it is editable, movable and
      // yours to delete. Athena just picks the moment and gets out of the way.
      const parts = m.dataset.addbreak.split('|');
      openEditor({ date: parts[1], title: 'Break', cat: (S.categories[0] || {}).id });
      if (editing){ editing.start = parts[0]; editing.end = fmtM(Math.min(DE, mins(parts[0]) + 15)); render(); }
      return;
    }
    if ((m = t('[data-autofill]'))){
      if (!S.profile) S.profile = blank().profile;
      S.profile.autofill = !!m.checked;
      save(); render(); return;
    }

    if ((m = t('[data-timerset]'))){ timerReset(+m.dataset.timerset); return; }
    if (t('[data-timertarget]')) return;   // a select; handled on change, not click
    if (t('[data-timerstart]')){ timerStart(); return; }
    if (t('[data-timerpause]')){ timerPause(); return; }
    if (t('[data-timerreset]')){ timerReset(); return; }

    if ((m = t('[data-parkopen]'))){
      const i = +m.dataset.parkopen;
      parkOpen = (parkOpen === i) ? null : i;
      render(); return;
    }
    if ((m = t('[data-parkinto]'))){
      const parts = m.dataset.parkinto.split('|');
      const kind = parts[0], i = +parts[1], dk = parts[2];
      const item = (S.parked || [])[i];
      if (!item) return;
      parkOpen = null;
      if (kind === 'block'){
        // The editor takes the thought out of the park itself, once saved.
        openEditor({ date: dk, title: item.t, fromParked: i });
        return;
      }
      if (kind === 'note'){
        const n = newNote('text');
        n.title = item.t.slice(0, 140);
        S.parked.splice(i, 1);
        view = 'notes'; noteEdit = n;
        save(); render(); return;
      }
      const stamp = new Date().toISOString();
      const tk = {
        id: 'tk_' + uid8(), title: item.t.slice(0, 140), note: '',
        cat: (S.categories[0] || {}).id, priority: 'normal',
        due: null, dateType: 'by', mins: null, repeat: null, at: null,
        createdAt: stamp, doneAt: null
      };
      if (kind === 'appt'){
        // An appointment is a task with a time. Start it at the next round hour
        // on the day being looked at, then open it so the time can be set.
        const now = new Date();
        const hr = Math.min(23, now.getHours() + 1);
        tk.due = dk; tk.dateType = 'on'; tk.at = pad(hr) + ':00'; tk.mins = 30;
      }
      S.tasks = (S.tasks || []).concat([tk]);
      S.parked.splice(i, 1);
      save();
      // An appointment opens for its time to be set. A plain task does not need
      // anything else said about it, so it just lands.
      if (kind === 'appt') openTaskEditor(tk.id); else render();
      return;
    }
    if ((m = t('[data-unpark]'))){ markUndo('Thought cleared'); S.parked.splice(+m.dataset.unpark, 1); save(); render(); return; }
  });

  // Re-render the editor when repeat type or all-day toggles (to swap fields).
  shell.addEventListener('change', e => {
    if (!editing) return;
    if (e.target.id === 'e_repeat' || e.target.id === 'e_allday'){ syncEditor(); render(); }
  });

  function toggleStep(gid, sid, now){
    const g = S.goals.find(x=>x.id===gid); if (!g) return;
    const st = g.steps.find(s=>s.id===sid); if (!st) return;
    if (st.freq === 'daily') toggleDone(sid, dayKey(now));
    else if (st.freq === 'weekly') toggleDone('w:'+sid, weekKey(now));
    else toggleDone('m:'+sid, monKey(now));
  }
  function commitSettings(){
    const nm = document.getElementById('s_name');
    if (nm) S.profile.name = nm.value.trim().slice(0,40);
    S.categories.forEach(c => {
      const lab = document.querySelector('[data-catlabel="'+c.id+'"]');
      const col = document.querySelector('[data-catcolor="'+c.id+'"]');
      if (lab) c.label = lab.value.trim().slice(0,30) || c.label;
      if (col) c.color = col.value;
    });
    save();
  }

  shell.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'auth_email'){ e.preventDefault(); sendCode(); return; }
    if (e.key === 'Enter' && e.target.id === 'auth_code'){ e.preventDefault(); verifyCode(); return; }
    if (e.key === 'Enter' && e.target.id === 'ob_name'){ e.preventDefault(); obSync(); ob.step = 1; render(); return; }
    if (e.key === 'Enter' && e.target.id === 'ob_newcat'){ e.preventDefault(); obAddCustom(); return; }
    if (e.key === 'Enter' && e.target.id === 'sk'){
      e.preventDefault(); const v = e.target.value.trim();
      if (v){ S.parked.push({ t:v.slice(0,200) }); clearDraft('sk'); save(); render(); const i = document.getElementById('sk'); if (i) i.focus(); }
    }
    if (e.key === 'Enter' && e.target.id === 'tk_title'){ e.preventDefault(); const b = app.querySelector('[data-addtask]'); if (b) b.click(); return; }
    if (e.key === 'Enter' && e.target.id === 'nt_quick'){ e.preventDefault(); const b = app.querySelector('[data-notequick]'); if (b) b.click(); return; }
    if (e.key === 'Enter' && e.target.id === 'ne_newitem'){ e.preventDefault(); const b = app.querySelector('[data-noteadditem]'); if (b) b.click(); return; }
    if (e.key === 'Escape' && (editing || settingsOpen || aiOpen || taskEdit || noteEdit)){
      if (noteEdit){ const b = app.querySelector('[data-notecancel]'); if (b){ b.click(); return; } }
      editing = null; taskEdit = null; settingsOpen = false; aiOpen = false; aiPreview = null; aiStep = 'input';
      clearDraft('ai_ask'); clearModalDrafts(); render();
    }
  });

  // Re-flow the layout when the screen size or orientation changes, so views
  // expand and contract live (strips <-> grid, wide <-> narrow). Debounced, and
  // skipped while typing so it never yanks focus mid-edit.
  let rzt = null;
  function onResize(){
    clearTimeout(rzt);
    rzt = setTimeout(() => {
      const ae = document.activeElement;
      if (ae && app.contains && app.contains(ae) &&
          (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
      render();
    }, 150);
  }
  if (typeof window !== 'undefined'){
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  /* ---------- auth gate & login screen ---------- */
  let started = false;
  let authMsg = '';
  let authBusy = false;
  // Sign-in is a code you type, not a link you tap. A link opens in whichever
  // browser the mail app chooses, so on a phone the session lands somewhere
  // other than where you were, and an app on the home screen has no address bar
  // to paste it into: there is no way to finish signing in at all. A code never
  // leaves the app. The email still carries a link as well, for laptops.
  let authStep = 'email';        // 'email' | 'code'
  let authEmail = '';

  function loginHTML(){
    let h = '<div class="login">';
    h += '<div class="login-mark">' + MOON + '</div>';
    if (authStep === 'code'){
      h += '<h1>Check your email</h1>';
      h += '<p class="login-sub">We sent a six digit code to <b>'+esc(authEmail)+'</b>. Enter it below to finish signing in.</p>';
      h += '<div class="login-box">'+
        '<input id="auth_code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" '+
          'maxlength="6" placeholder="123456" class="codebox">'+
        '<button class="go" data-verifycode'+(authBusy?' disabled':'')+'>'+(authBusy?'Checking…':'Sign in')+'</button>'+
        '</div>';
      if (authMsg) h += '<p class="login-msg">' + esc(authMsg) + '</p>';
      h += '<div class="login-alt"><button class="linkish" data-sendcode>Send a new code</button>'+
        '<button class="linkish" data-authback>Use a different email</button></div>';
      h += '<p class="login-fine">The code lasts an hour. The email has a link in it too, if you would rather tap that on a computer.</p>';
    } else {
      h += '<h1>Athena</h1>';
      h += '<p class="login-sub">A calm place to plan your days. Sign in and it syncs across your phone and laptop.</p>';
      h += '<div class="login-box">'+
        '<input id="auth_email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="you@email.com">'+
        '<button class="go" data-sendcode'+(authBusy?' disabled':'')+'>'+(authBusy?'Sending…':'Email me a sign-in code')+'</button>'+
        '</div>';
      if (authMsg) h += '<p class="login-msg">' + esc(authMsg) + '</p>';
      h += '<p class="login-fine">No passwords. We email you a six digit code.</p>';
    }
    h += '</div>';
    return h;
  }
  function renderAuth(){
    app.classList.remove('wide');
    app.innerHTML = loginHTML();
    const i = document.getElementById('auth_email');
    if (i && drafts['auth_email']) i.value = drafts['auth_email'];
    const c = document.getElementById('auth_code');
    if (c) c.focus();
  }

  async function sendCode(){
    // On the code step this is "send a new one", so fall back to the address we
    // already have rather than an input that is no longer on screen.
    const i = document.getElementById('auth_email');
    const email = (((i && i.value) || authEmail) || '').trim();
    if (!email || email.indexOf('@') === -1){ authMsg = 'Enter a valid email address.'; renderAuth(); if (i) i.focus(); return; }
    if (!sb){ authMsg = 'Sign-in is not configured.'; renderAuth(); return; }
    authBusy = true; authMsg = ''; renderAuth();
    try {
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      authBusy = false;
      if (error){
        authMsg = /rate|limit|seconds/i.test(error.message || '')
          ? 'That is too many emails for now. Wait a few minutes and try once more.'
          : 'Could not send the code: ' + error.message;
      } else {
        authEmail = email; authStep = 'code';
        authMsg = '';
      }
    } catch(e){ authBusy = false; authMsg = 'Something went wrong. Please try again.'; }
    renderAuth();
  }

  async function verifyCode(){
    const c = document.getElementById('auth_code');
    const token = ((c && c.value) || '').replace(/\D/g, '');
    if (token.length < 6){ authMsg = 'Enter the six digit code from the email.'; renderAuth(); return; }
    authBusy = true; authMsg = ''; renderAuth();
    try {
      const { error } = await sb.auth.verifyOtp({ email: authEmail, token, type: 'email' });
      authBusy = false;
      if (error){
        // Supabase answers "token has expired or is invalid" for a mistyped code
        // and an old one alike, so do not pretend to know which. Telling someone
        // their code expired when they fat-fingered a digit sends them off for a
        // new email they did not need.
        authMsg = 'That code did not work. Check the digits, or send a new one if the email has been sitting a while.';
        renderAuth();
        return;
      }
      // onAuthStateChange starts the app; nothing else to do here.
      authMsg = ''; authStep = 'email';
    } catch(e){ authBusy = false; authMsg = 'Something went wrong. Please try again.'; renderAuth(); }
  }

  function startApp(){
    if (started) return;
    started = true;
    load().then(() => {
      applyTheme();
      render();
      consumeShare();      // anything Android handed us on the way in
      setInterval(() => {
        const ae = document.activeElement;
        if (editing || settingsOpen || aiOpen || taskEdit) return;
        if (ae && app.contains && app.contains(ae) &&
            (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
        render();
      }, 60000);
    });
  }

  async function boot(){
    keepDrafts();
    timerLoad();
    timerLoop();      // a timer left running survives a reload and picks up where it was
    updateIfStale();     // deliberately not awaited: never hold the app on it
    if (!sb){ startApp(); return; }                    // no config -> local-only
    try { const { data } = await sb.auth.getSession(); session = data.session || null; }
    catch(_){ session = null; }
    sb.auth.onAuthStateChange((event, s) => {
      session = s || null;
      if (session && !started) startApp();
      else if (!session && started) location.reload();  // signed out -> back to login
    });
    if (session) startApp();
    else renderAuth();
  }
  boot();

  // Register the service worker (installable + offline). Harmless where unsupported.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // ----- keep the app fresh: notice a new deploy and update, gently -----
  // When a new version ships, an already-open app keeps running the old code
  // until it reloads. We watch app.js's ETag; on a change we reload if the user
  // is idle, or show an unobtrusive "Refresh" pill if they're mid-task.
  let bootTag = null, updatePending = false, reloadingForUpdate = false;

  function userBusy(){
    const ae = document.activeElement;
    return !!(editing || settingsOpen || aiOpen || ob || taskEdit || noteEdit ||
      (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')));
  }
  function applyUpdate(){
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  }
  function showUpdatePill(){
    if (document.getElementById('ath-update')) return;
    const el = document.createElement('div');
    el.id = 'ath-update';
    const span = document.createElement('span'); span.textContent = 'Athena just updated.';
    const btn = document.createElement('button'); btn.textContent = 'Refresh';
    btn.addEventListener('click', applyUpdate);
    el.appendChild(span); el.appendChild(btn);
    document.body.appendChild(el);
  }
  function onUpdateReady(){
    updatePending = true;
    if (userBusy()) showUpdatePill(); else applyUpdate();
  }
  async function checkForUpdate(){
    try {
      const r = await fetch('./app.js', { cache: 'no-store' });
      if (!r || !r.ok) return;
      const tag = r.headers.get('etag') || r.headers.get('last-modified') || String(r.headers.get('content-length') || '');
      if (!tag) return;
      if (bootTag === null){ bootTag = tag; return; }   // record baseline once
      if (tag !== bootTag && !updatePending) onUpdateReady();
    } catch(_){ /* offline — try again later */ }
  }
  if (typeof window !== 'undefined'){
    checkForUpdate();                              // record the baseline now
    setInterval(checkForUpdate, 5 * 60 * 1000);    // and watch every 5 minutes
    // If a deferred update is pending, apply it as soon as the user goes idle.
    setInterval(() => { if (updatePending && !userBusy()) applyUpdate(); }, 15 * 1000);
  }
})();

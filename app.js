(function () {
  'use strict';

  /* ==========================================================================
     Athena — personal life planner
     Data model v2: date-based events with recurrence, per-user (one JSON blob).
     Storage goes through the single `store` object below — swap it for Supabase
     in Phase B. See SPEC.md.
     ========================================================================== */

  const KEY = 'athena:v2';   // also the local offline-cache key

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
  let session = null;          // current auth session (set in boot)

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch(_){ return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(_){} };

  // Storage adapter — the only I/O boundary. When signed in, reads/writes the
  // user's single row in `dashboards`; always write-through to a local cache so
  // the app still opens offline (and to keep working when Supabase is absent).
  // updated_at of the cloud copy we last read or wrote — lets us tell whether
  // another device has changed things since (see syncFromCloud).
  let lastRemoteAt = null;

  const store = {
    get: async () => {
      if (cloud && session){
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
      if (cloud && session){
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
      ev({ title:'Morning routine', cat:'health',   start:'07:00', end:'07:30', rrule:wk(every) }),
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
    completions: {}   // { 'YYYY-MM-DD': { <itemId>: true | <number> } }
  });

  let S = blank();
  let ok = true;
  let view = 'day';
  let openDay = null;                 // week strips: which day is expanded
  let openGoal = null;
  let openBlockTasks = null;          // which block has its task list expanded
  let manageBlocks = false;           // Week view: showing the whole-rhythm editor
  let expanded = (typeof window !== 'undefined' && window.innerWidth >= 900);
  let editing = null;                 // event-editor state, or null
  // Which day/week you're looking at, as an offset in days from today. Day view
  // steps by 1, Week view by 7 (so the weekday stays put when you change week).
  let dayShift = 0;
  const viewDate = () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + dayShift); return d; };
  // The full 7-column grid needs real width; below this we always show strips.
  const canGrid = () => (typeof window !== 'undefined' && window.innerWidth >= 700);
  const gridShown = () => expanded && canGrid();

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
    catch(e){ reachedRemote = false; }               // offline or not signed in
    const localRaw = lsGet(KEY);

    if (remote){
      // Cloud is the source of truth.
      S = Object.assign(blank(), JSON.parse(remote));
      lsSet(KEY, remote);                            // refresh offline cache
    } else if (localRaw){
      // No cloud copy yet — adopt what's on this device...
      S = Object.assign(blank(), JSON.parse(localRaw));
      if (cloud && reachedRemote) save();            // ...and migrate it up to the account
    }
    // else: brand-new account — leave it empty and not onboarded, so the guided
    // setup runs on first render. Nothing is saved until they finish setup.
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
  const prefersLight = () => (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-color-scheme: light)').matches : false;
  function themeChoice(){ return (S.profile && S.profile.theme) || 'dark'; }
  function applyTheme(){
    const choice = themeChoice();
    const resolved = choice === 'system' ? (prefersLight() ? 'light' : 'dark') : choice;
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
    if (cached) document.documentElement.setAttribute('data-theme',
      cached === 'system' ? (prefersLight() ? 'light' : 'dark') : cached);
  } catch(_){}
  if (typeof window !== 'undefined' && window.matchMedia){
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => { if (themeChoice() === 'system') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  /* ---------- categories ---------- */
  const catOf = id => S.categories.find(c => c.id === id) || S.categories[0] || DEFAULT_CATS[0];
  const catColor = id => catOf(id).color;

  /* ==========================================================================
     Guided first-run setup — a brand-new account (not onboarded, no events)
     gets a short, warm flow that builds a starter week from a few answers.
     ========================================================================== */
  let ob = null;   // onboarding state, or null
  const needsOnboarding = () => !(S.profile && S.profile.onboarded) && !((S.events || []).length);

  const OB_CATS = [
    { id:'work',     label:'Work',     color:'#8DA9C4' },
    { id:'study',    label:'Study',    color:'#B0A8CE' },
    { id:'family',   label:'Family',   color:'#C4A8CE' },
    { id:'health',   label:'Health',   color:'#9CC0A9' },
    { id:'home',     label:'Home',     color:'#C4B79A' },
    { id:'admin',    label:'Life admin', color:'#93B0B5' },
    { id:'creative', label:'Creative', color:'#D0A8B0' }
  ];

  function obSync(){
    if (!ob) return;
    const g = id => document.getElementById(id);
    if (g('ob_name'))  ob.name  = g('ob_name').value;
    if (g('ob_start')) ob.start = g('ob_start').value || ob.start;
    if (g('ob_end'))   ob.end   = g('ob_end').value || ob.end;
  }

  function obBuildStarter(startT, endT){
    const cats = S.categories;
    const byLabel = l => cats.find(c => c.label.toLowerCase() === l.toLowerCase());
    const firstOf = (...labels) => { for (const l of labels){ const c = byLabel(l); if (c) return c.id; } return cats[0].id; };
    const health   = firstOf('Health', 'Fitness');
    const workish  = firstOf('Work', 'Study');
    const personal = firstOf('Family', 'Home', 'Personal', 'Creative');
    const from = weekKey(new Date());
    const everyday = { freq:'weekly', interval:1, weekdays:[0,1,2,3,4,5,6], from };
    const weekdays = { freq:'weekly', interval:1, weekdays:[1,2,3,4,5], from };
    const addMin = (t, m) => fmtM(mins(t) + m);
    const ev = o => Object.assign({ id:'ev_'+uid8(), note:'', allDay:false, ex:{}, skip:[], date:null }, o);

    const events = [ ev({ title:'Morning', cat:health, start:startT, end:addMin(startT, 30), rrule:everyday }) ];
    if (byLabel('Work') || byLabel('Study'))
      events.push(ev({ title:(byLabel('Work') ? 'Focus time' : 'Study block'), cat:workish, start:'09:00', end:'11:00', rrule:weekdays }));
    events.push(ev({ title:'Lunch', cat:personal, start:'12:30', end:'13:00', rrule:everyday }));
    events.push(ev({ title:'Wind down', cat:personal, start:endT, end:addMin(endT, 30), rrule:everyday }));
    S.events = events;

    const habits = [];
    if (byLabel('Health') || byLabel('Fitness')){
      habits.push({ id:'hb_'+uid8(), label:'Move your body', cat:health, target:1 });
      habits.push({ id:'hb_'+uid8(), label:'Water', cat:health, target:4 });
    }
    S.habits = habits;
  }

  function obFinish(){
    obSync();
    S.profile.name = (ob.name || '').trim().slice(0, 40);
    const chosen = ob.cats.length ? ob.cats : ['personal'];
    let cats = chosen.map(id => OB_CATS.find(c => c.id === id)).filter(Boolean).map(c => ({ id:c.id, label:c.label, color:c.color }));
    if (!cats.length) cats = DEFAULT_CATS.map(c => Object.assign({}, c));
    S.categories = cats;
    obBuildStarter(ob.start || '07:00', ob.end || '21:00');
    S.profile.onboarded = true;
    ob = null; view = 'day';
    save(); render();
  }

  function obSkip(){
    obSync();
    S.profile.name = (ob && ob.name ? ob.name : '').trim().slice(0, 40);
    S.categories = DEFAULT_CATS.map(c => Object.assign({}, c));
    firstRun();                 // generic starter, marks onboarded
    ob = null; view = 'day';
    save(); render();
  }

  function onboardingHTML(){
    if (!ob) ob = { step:0, name:(S.profile && S.profile.name) || '', cats:[], start:'07:00', end:'21:00' };
    let h = '<div class="ob"><div class="ob-mark">' + MOON + '</div>';
    if (ob.step === 0){
      h += '<h1>Welcome to Athena</h1>';
      h += '<p class="ob-sub">A calm place to plan your days. A couple of quick questions and it\'s yours.</p>';
      h += '<label class="fld"><span>What should we call you?</span><input id="ob_name" type="text" autocomplete="given-name" placeholder="Your name" value="'+esc(ob.name)+'"></label>';
      h += '<div class="ob-actions"><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
      h += '<button class="linkish ob-skip" data-obskip>Skip, just set me up</button>';
    } else if (ob.step === 1){
      h += '<h1>What are your days about?</h1>';
      h += '<p class="ob-sub">Pick a few. These become your colour-coded categories. Rename, recolour or change them anytime.</p>';
      h += '<div class="ob-chips">' + OB_CATS.map(c =>
        '<button class="ob-chip'+(ob.cats.indexOf(c.id) !== -1 ? ' on' : '')+'" data-obcat="'+c.id+'">'+
        '<span class="cd" style="background:'+c.color+'"></span>'+c.label+'</button>').join('') + '</div>';
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
    } else if (ob.step === 2){
      h += '<h1>Your rhythm</h1>';
      h += '<p class="ob-sub">Roughly when does your day start and wind down? We\'ll sketch a light week you can reshape, or fill it with your AI later.</p>';
      h += '<div class="fld two"><label><span>Day starts</span><input id="ob_start" type="time" value="'+ob.start+'"></label>'+
        '<label><span>Wind down</span><input id="ob_end" type="time" value="'+ob.end+'"></label></div>';
      h += '<div class="ob-actions"><button class="ghost" data-obback>Back</button><span style="flex:1"></span><button class="go" data-obnext>Next</button></div>';
    } else {
      const cc = S.categories.map(c => c.color);
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
  // Everything that appears on a given day: real events + scheduled goal steps.
  function blocksForDate(D){
    const all = eventsOnDate(D).concat(stepBlocksOnDate(D));
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
    habitList().forEach(hb => { total++; if (isDone(hb.id, dk, hb.target)) done++; });
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
    if (tk.dateType === 'on') return tk.due === dayKey(d);
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
  const tasksForCat = (catId, d) =>
    openTasks(d).filter(tk => tk.cat === catId && taskAvailableOn(tk, d)).sort(taskSorter(d));
  const totalMins = list => list.reduce((a, tk) => a + (tk.mins || 0), 0);

  /* ==========================================================================
     Views
     ========================================================================== */
  const DS = 360, DE = 1290, SPAN = DE - DS;   // day window: 6am → 9:30pm

  function weekTotals(tot){
    const cats = S.categories;
    const all = cats.reduce((a,c) => a + (tot[c.id]||0), 0) || 1;
    let h = '<div class="wtot"><div class="balbar">' + cats.map(c =>
      tot[c.id] ? '<i style="width:'+(tot[c.id]/all*100)+'%;background:'+c.color+'"></i>' : '').join('') + '</div>';
    h += '<div class="balkey">' + cats.filter(c=>tot[c.id]).map(c =>
      '<span><b style="background:'+c.color+'"></b>'+esc(c.label)+' '+dur(tot[c.id])+'</span>').join('') + '</div>';
    const committed = cats.reduce((a,c) => a + (tot[c.id]||0), 0);
    h += '<p class="slack" style="padding-top:0">Across the week that is <b>'+dur(committed)+'</b> committed.</p></div>';
    return h;
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

    if (gridShown()){
      const H = 680, px = m => (m - DS) / SPAN * H;
      h += '<div class="calhead"><span class="sp"></span><span class="hs">' +
        ORDER.map((d,pos) => '<span'+(pos===todayPos?' class="td"':'')+'>'+LBL[d]+'</span>').join('') + '</span></div>';
      let hrs = '';
      for (let m = DS; m <= DE; m += 60) hrs += '<u style="top:'+px(m)+'px">'+clockOf(pad(Math.floor(m/60))+':00')+'</u>';
      let cols = '';
      ORDER.forEach((d, pos) => {
        let inner = '';
        for (let m = DS + 60; m < DE; m += 60) inner += '<div class="gl" style="top:'+px(m)+'px"></div>';
        blocksByDay[d].forEach(b => {
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
            'background:'+col+'2E;border-left-color:'+col+'" data-editinst="'+b.id+'|'+dayKey(dates[d])+'" '+
            'data-uid="'+b.id+'" data-dk="'+dayKey(dates[d])+'" data-sm="'+mins(b.s)+'" data-em="'+mins(b.e)+'" data-pos="'+pos+'">'+
            '<b>'+esc(b.t)+'</b><em>'+clockOf(b.s)+'–'+clockOf(b.e)+'</em><i class="rz"></i></button>';
        });
        if (pos === todayPos && t >= DS && t <= DE) inner += '<div class="cbnow" style="top:'+px(t)+'px"></div>';
        cols += '<div class="calcol'+(pos===todayPos?' td':'')+'" data-newon="'+dayKey(dates[d])+'">'+inner+'</div>';
      });
      h += '<div class="cal"><div class="calhrs" style="height:'+H+'px">'+hrs+'</div>'+
        '<div class="calcols" style="height:'+H+'px">'+cols+'</div></div>';
      h += weekTotals(tot);
      return h;
    }

    // mobile strips
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

    const row = (e, dateCtx) =>
      '<div class="brow">'+
        '<span class="cd" style="background:'+catColor(e.cat)+'"></span>'+
        '<button class="bmain" data-editinst="'+e.id+'|'+dateCtx+'">'+
          '<span class="bt">'+esc(e.title)+'</span>'+
          '<span class="bw">'+esc(aiWhen(e))+'</span>'+
        '</button>'+
        '<button class="del" data-delevent="'+e.id+'" aria-label="Remove block">×</button>'+
      '</div>';

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

  function dayRail(vd, now){
    const isToday = dayKey(vd) === dayKey(now);
    // Only "today" has a live moment; other days render as plain, unstyled time.
    const t = isToday ? (now.getHours()*60 + now.getMinutes()) : -1;
    const dk = dayKey(vd);
    const all = blocksForDate(vd);
    const allDay = all.filter(b => b.allDay);
    const blocks = all.filter(b => !b.allDay);

    const items = [];
    blocks.forEach((b,i) => {
      items.push({ type:'block', b:b });
      const nx = blocks[i+1];
      if (nx){ const g = mins(nx.s) - mins(b.e); if (g >= 30) items.push({ type:'gap', from:mins(b.e), to:mins(nx.s), next:nx }); }
    });
    const openTotal = items.filter(x=>x.type==='gap').reduce((a,x)=>a+(x.to-x.from),0);
    const timed = blocks.filter(b => !b.step);                // goal steps don't count as "booked"
    const booked = timed.reduce((a,b)=>a+(mins(b.e)-mins(b.s)),0);
    const split = {};
    timed.forEach(b => { split[b.c] = (split[b.c]||0) + (mins(b.e)-mins(b.s)); });

    let h = '';
    if (isToday) h += dayProgressHTML();   // progress is about today, not a day you're browsing
    if (booked){
      h += '<p class="slack">Today asks for <b>'+dur(booked)+'</b>, and leaves <b>'+dur(openTotal)+'</b> open in between. There is room.</p>';
      h += '<div class="balbar">' + S.categories.map(c =>
        split[c.id] ? '<i style="width:'+(split[c.id]/booked*100)+'%;background:'+c.color+'"></i>' : '').join('') + '</div>';
      h += '<div class="balkey">' + S.categories.filter(c=>split[c.id]).map(c =>
        '<span><b style="background:'+c.color+'"></b>'+esc(c.label)+' '+dur(split[c.id])+'</span>').join('') + '</div>';
    } else {
      h += '<p class="slack">Nothing scheduled '+(isToday ? 'today' : 'this day')+'. '+
        '<button class="linkish" data-newon="'+dk+'">Add something</button>, or enjoy the open day.</p>';
    }

    if (allDay.length){
      h += '<div class="allday">' + allDay.map(b =>
        '<button class="adchip" data-editinst="'+b.id+'|'+dk+'" style="border-color:'+catColor(b.c)+'55">'+
        '<span class="sw" style="background:'+catColor(b.c)+'"></span>'+esc(b.t)+'</button>').join('') + '</div>';
    }

    items.forEach(it => {
      if (it.type === 'gap'){
        const live = t >= it.from && t < it.to;
        h += '<div class="item gap '+(live?'live':(t>=it.to?'past':'future'))+'">'+
          '<div class="clock"></div><div class="track"></div>'+
          '<div class="card"><div class="t">'+
          (live ? dur(it.to - t) + ' before ' + esc(it.next.t) : dur(it.to - it.from) + ' open') +
          '</div></div></div>';
        return;
      }
      const b = it.b;
      const isStep = !!b.step;
      const live = t >= mins(b.s) && t < mins(b.e);
      const past = t >= mins(b.e);
      const done = isStep ? isDone('w:' + b.step.sid, weekKey(vd)) : isDone(b.id, dk);
      const col = catColor(b.c);
      let dotStyle = '';
      if (done) dotStyle = 'background:'+col+';border-color:'+col;
      else if (live) dotStyle = 'background:var(--live);border-color:var(--live)';
      else if (!past) dotStyle = 'border-color:'+col;
      const doneAct = isStep ? 'data-stepweek="'+b.step.gid+':'+b.step.sid+'|'+dk+'"' : 'data-done="'+b.id+'|'+dk+'"';
      h += '<div class="item '+(live?'live':past?'past':'future')+(done?' done':'')+(isStep?' step':'')+((justDone === (isStep ? b.step.sid : b.id))?' just':'')+'">'+
        '<div class="clock">'+clockOf(b.s)+'</div>'+
        '<div class="track"><button class="dot" '+doneAct+' style="'+dotStyle+'" '+
          'aria-label="'+(done ? 'Undo ' : 'Tick off ')+esc(b.t)+'">'+TICK+'</button></div>'+
        '<div class="card"><div class="cardrow">'+
        '<button class="cardmain" '+doneAct+'>'+
        '<div class="t">'+esc(b.t)+'</div>'+
        (b.n?'<div class="n">'+esc(b.n)+'</div>':'');
      if (live){
        const pct = ((t - mins(b.s)) / (mins(b.e) - mins(b.s))) * 100;
        h += '<div class="meter"><i style="width:'+pct.toFixed(1)+'%"></i></div>'+
          '<div class="left">'+dur(mins(b.e)-t)+' to go</div>';
      }
      h += '</button>'+
        (isStep ? '<button class="editdot" data-gotogoal="'+b.step.gid+'" aria-label="Open goal">›</button>'
                : '<button class="editdot" data-editinst="'+b.id+'|'+dk+'" aria-label="Edit">⋯</button>')+
        '</div>';
      // Tasks waiting in this block's category
      const bt = isStep ? [] : tasksForCat(b.c, vd);
      if (bt.length){
        const openHere = openBlockTasks === b.uid;
        const est = totalMins(bt);                       // estimated work waiting
        const blockLen = mins(b.e) - mins(b.s);          // room available
        h += '<div class="btasks"><button class="taskchip'+(openHere?' on':'')+'" data-blocktasks="'+b.uid+'">'+
          bt.length+' task'+(bt.length !== 1 ? 's' : '')+(est ? ' · '+dur(est) : '')+
          '<em>'+(openHere ? '▴' : '▾')+'</em></button>';
        if (openHere){
          if (est) h += '<div class="tfit'+(est > blockLen ? ' over' : '')+'">'+
            (est > blockLen
              ? dur(est)+' of tasks, only '+dur(blockLen)+' here'
              : dur(est)+' of tasks in a '+dur(blockLen)+' block')+'</div>';
          h += '<div class="tlist inblock">'+bt.map(tk => taskRow(tk, vd, true)).join('')+'</div>';
        }
        h += '</div>';
      }
      h += '</div></div>';
    });

    h += '<div class="dayadd"><button data-newon="'+dk+'">+ New event</button>'+
      '<button class="ai-btn" data-aiopen>✦ Ask your AI</button></div>';
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
  function chipsHTML(now){
    const dk = dayKey(now);
    let h = '<div class="chips">';
    habitList().forEach(d => {
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
  function habitsView(now){
    const today = dayKey(now);
    const monday = parseDay(weekKey(now));
    const start = new Date(monday); start.setDate(monday.getDate() - 21);

    let h = '<h2>Every day</h2>' + chipsHTML(now);
    h += '<h2>The last four weeks</h2>';
    h += '<div class="habhead"><div class="hdow">' + ['M','T','W','T','F','S','S'].map(x=>'<span>'+x+'</span>').join('') + '</div></div>';

    habitList().forEach(d => {
      const col = catColor(d.c);
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
        '<small>'+count+' of '+elapsed+' days'+(streak>1?' · <em>'+streak+' day run</em>':'')+'</small></div>'+
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
    if (tk.mins) bits.push('<i class="tmins">'+dur(tk.mins)+'</i>');
    if (tk.repeat) bits.push('<i>'+repeatLabel(tk.repeat)+'</i>');
    return '<div class="trow'+(done?' done':'')+(justDone===tk.id?' just':'')+'">'+
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

    let h = '<div class="gform taskadd">'+
      '<input id="tk_title" type="text" placeholder="What needs doing?" autocomplete="off">'+
      '<div class="frow">'+
        '<select id="tk_cat">'+CATOPTS+'</select>'+
        '<select id="tk_prio">'+PRIOS.map(p => "<option value='"+p[0]+"'"+(p[0]==='normal'?' selected':'')+">"+p[1]+"</option>").join('')+'</select>'+
      '</div>'+
      '<div class="frow">'+
        '<select id="tk_when">'+DATEKINDS.map(k => "<option value='"+k[0]+"'>"+k[1]+"</option>").join('')+'</select>'+
        '<input id="tk_due" type="date">'+
      '</div>'+
      '<div class="frow">'+
        '<select id="tk_rep"><option value="once" selected>One-off</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>'+
        '<select id="tk_mins">'+MINOPTS.map(o => "<option value='"+o[0]+"'>"+o[1]+"</option>").join('')+'</select>'+
      '</div>'+
      '<button class="go" data-addtask>Add task</button>'+
      '<small class="gform-hint">Only the name is required. "Due by" stays on your list until it is done; "Do on" only turns up that day.</small></div>';

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
    taskEdit = { id: tk.id, title: tk.title, note: tk.note || '', cat: tk.cat,
      priority: tk.priority || 'normal', due: tk.due || '',
      dateType: tk.dateType || 'by', mins: tk.mins || 0,
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
    h += '<label class="fld"><span>How long will it take?</span><select id="te_mins">'+MINOPTS.map(o=>"<option value='"+o[0]+"'"+(o[0]===e.mins?' selected':'')+">"+o[1]+"</option>").join('')+'</select></label>';
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
    taskEdit = null; clearModalDrafts(); save(); render();
  }

  function parkHTML(dk){
    let h = '<div class="park"><div class="park-row">'+
      '<input id="sk" type="text" placeholder="Park a stray thought…" autocomplete="off">'+
      '<button data-park>Park</button></div>';
    h += (S.parked||[]).length
      ? '<ul class="parked">'+S.parked.map((p,i) =>
          '<li><span>'+esc(p.t)+'</span>'+
          '<button class="parkdo" data-parkschedule="'+i+'|'+dk+'" aria-label="Schedule this" title="Put it in the calendar">→</button>'+
          '<button data-unpark="'+i+'" aria-label="Remove">×</button></li>').join('')+'</ul>'
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
        title: opts.title || '', note: '', cat: (S.categories[0]||{}).id, allDay: false,
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
    app.addEventListener('input',  e => { if (e.target.id) drafts[e.target.id] = e.target.type==='checkbox'?e.target.checked:e.target.value; });
    app.addEventListener('change', e => { if (e.target.id) drafts[e.target.id] = e.target.type==='checkbox'?e.target.checked:e.target.value; });
  }
  const clearDraft = id => { delete drafts[id]; };
  const MODAL_IDS = ['e_title','e_note','e_cat','e_allday','e_start','e_end','e_repeat','e_date','e_monthday','s_name',
    'te_title','te_note','te_cat','te_prio','te_rep','te_due','te_when','te_mins','tk_when','tk_mins'];
  const clearModalDrafts = () => MODAL_IDS.forEach(clearDraft);

  function paint(h){
    const ae = document.activeElement;
    const focusId = (ae && ae.id) ? ae.id : null;
    let caret = null;
    try { caret = (ae && ae.selectionStart != null) ? ae.selectionStart : null; } catch(_){}
    const sy = (typeof window !== 'undefined' && window.scrollY) || 0;
    app.innerHTML = h;
    Object.keys(drafts).forEach(id => {
      const el = document.getElementById(id);
      if (el){ if (el.type==='checkbox') el.checked = drafts[id]; else el.value = drafts[id]; }
    });
    if (focusId){
      const el = document.getElementById(focusId);
      if (el){ el.focus(); if (caret != null && el.setSelectionRange){ try { el.setSelectionRange(caret, caret); } catch(_){} } }
    }
    if (typeof window !== 'undefined' && window.scrollTo && sy) window.scrollTo(0, sy);
  }

  // Prev / next / back-to-today for the Day and Week views.
  function dateNav(vd, now){
    if (view !== 'day' && view !== 'week') return '';
    if (manageBlocks) return '';        // the rhythm editor is not tied to a date
    const step = view === 'week' ? 7 : 1;
    let label, rel = '';
    if (view === 'day'){
      const diff = daysBetween(dayKey(now), dayKey(vd));
      rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : '';
      label = DAYS[vd.getDay()] + ' ' + vd.getDate() + ' ' + SHORT[vd.getMonth()];
    } else {
      const mon = parseDay(weekKey(vd));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const wdiff = Math.round(daysBetween(weekKey(now), weekKey(vd)) / 7);
      rel = wdiff === 0 ? 'This week' : wdiff === 1 ? 'Next week' : wdiff === -1 ? 'Last week' : '';
      label = mon.getDate() + ' ' + SHORT[mon.getMonth()] + ' – ' + sun.getDate() + ' ' + SHORT[sun.getMonth()];
    }
    let h = '<div class="datenav">';
    h += '<button class="dnav" data-shift="'+(-step)+'" aria-label="Previous">‹</button>';
    h += '<span class="dnlabel"><b>'+esc(label)+'</b>'+(rel ? '<small>'+rel+'</small>' : '')+'</span>';
    h += '<button class="dnav" data-shift="'+step+'" aria-label="Next">›</button>';
    if (dayShift !== 0) h += '<button class="dntoday" data-today>'+(view === 'week' ? 'This week' : 'Today')+'</button>';
    h += '</div>';
    return h;
  }

  function render(){
    if (needsOnboarding()){ app.classList.remove('wide'); paint(onboardingHTML()); return; }
    const now = new Date();
    const vd = viewDate();
    const hr = now.getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const name = (S.profile && S.profile.name) ? ', ' + esc(S.profile.name) : '';
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    let h = '';

    h += '<div class="greet"><div class="gtxt"><h1>'+greet+name+'</h1>'+
      '<p>'+DAYS[now.getDay()]+' '+now.getDate()+' '+MON[now.getMonth()]+' · '+
      clockOf(pad(now.getHours())+':'+pad(now.getMinutes()))+'</p></div>'+
      '<button class="motif" data-settings aria-label="Settings">'+(hr >= 20 || hr < 5 ? MOON : MOTIFS[doy % MOTIFS.length])+'</button></div>';
    h += '<div class="quote"><p>'+esc(LINES[doy % LINES.length])+'</p></div>';

    h += '<div class="segrow"><div class="seg">'+
      ['day','week','tasks','habits','goals'].map(v =>
        '<button data-view="'+v+'"'+(view===v?' class="on"':'')+'>'+v.charAt(0).toUpperCase()+v.slice(1)+'</button>').join('')+
      '</div>'+
      (view==='week' && canGrid() && !manageBlocks ? '<button class="expand" data-expand="1">'+(expanded?'Collapse to strips':'Expand to full grid')+'</button>' : '')+
      (view==='week' ? '<button class="expand" data-manageblocks="1">'+(manageBlocks?'Back to calendar':'Manage blocks')+'</button>' : '')+
      '</div>';
    app.classList.toggle('wide', view==='week' && gridShown());

    h += dateNav(vd, now);

    if (view === 'day')    h += dayRail(vd, now);
    else if (view === 'week')  h += manageBlocks ? blocksManagerHTML(now) : weekView(vd, now);
    else if (view === 'tasks')  h += tasksView(now);
    else if (view === 'habits') h += habitsView(now);
    else if (view === 'goals')  h += goalsView(now);

    // parked thoughts + everyday chips live under the Day view
    if (view === 'day'){ h += parkHTML(dayKey(vd)); }

    const savedLine = !ok ? 'Not saving right now.'
      : (cloud && session) ? 'Synced to your account. Saves as you go, on every device.'
      : 'Everything saves as you go, on this device.';
    h += '<footer>'+savedLine+'</footer>';

    if (celebrate) h += '<div class="celebrate"><span>'+esc(celebrate)+'</span></div>';
    if (undoState) h += '<div class="undobar"><span>'+esc(undoState.label)+'</span><button data-undo>Undo</button></div>';
    if (editing) h += editorHTML();
    if (taskEdit) h += taskEditorHTML();
    if (settingsOpen) h += settingsHTML();
    if (aiOpen) h += aiHTML();

    paint(h);
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
    if (cloud && session){
      h += '<div class="modal-h" style="margin-top:8px">Account</div>';
      h += '<div class="acctrow"><span class="acctmail">'+esc(session.user.email || 'Signed in')+'</span>'+
        '<button class="ghost" data-signout>Sign out</button></div>';
    }
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
      '  "tasks":  [ { "title": "", "category": "'+cats+'", "priority": "high|normal|low", "due": "YYYY-MM-DD", "dateType": "by|on", "minutes": 30, "repeat": "once|daily|weekly|monthly", "note": "" } ],',
      '  "habits": [ { "label": "", "category": "'+cats+'", "timesPerDay": 1 } ],',
      '  "goals":  [ { "title": "", "targetDate": "YYYY-MM-DD", "category": "'+cats+'", "steps": [ { "label": "", "freq": "daily|weekly|monthly" } ] } ]',
      '}',
      'Events are things with a time. Tasks are things to get done. Give each a category and priority. "due", "repeat" and "minutes" are optional.',
      'dateType says what the date means: "on" if it must happen that day, "by" if it just has to be finished by then. Default to "by".',
      'minutes is a rough estimate of how long the task takes, so it can be fitted into a block.',
      'Rules: weekdays are 0=Sun … 6=Sat. Use "date" only when repeat is "once". Omit "start"/"end" for an all-day item. Skip any field you don\'t need. Today is '+dayKey(new Date())+'.',
      'Here is what I want: '
    ].join('\n');
  }

  const matchCat = (name) => {
    if (!name) return (S.categories[0]||{}).id;
    const n = String(name).trim().toLowerCase();
    const c = S.categories.find(x => x.label.toLowerCase() === n || x.id === n);
    return c ? c.id : (S.categories[0]||{}).id;
  };

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
      return {
        id:'tk_'+uid8(), title:String(x.title).slice(0,140), note:String(x.note || '').slice(0,200),
        cat: matchCat(x.category),
        priority: (['high','normal','low'].indexOf(x.priority) >= 0 ? x.priority : 'normal'),
        due: (typeof x.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.due)) ? x.due : null,
        dateType: (x.dateType === 'on' ? 'on' : 'by'),
        mins: (typeof x.minutes === 'number' && x.minutes > 0) ? Math.min(600, Math.round(x.minutes)) : null,
        repeat: (['daily','weekly','monthly'].indexOf(rep) >= 0) ? { freq: rep, interval: 1 } : null,
        createdAt: new Date().toISOString(), doneAt: null
      };
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

  function aiApply(){
    if (!aiPreview) return;
    S.tasks = S.tasks || [];
    S.events.push.apply(S.events, aiPreview.events);
    S.tasks.push.apply(S.tasks, aiPreview.tasks || []);
    S.habits.push.apply(S.habits, aiPreview.habits);
    S.goals.push.apply(S.goals, aiPreview.goals);
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
    const tks = p.tasks || [];
    h += grp(tks.length+' task'+(tks.length !== 1 ? 's' : ''), tks.map(x =>
      '<div class="ai-row"><span class="cd" style="background:'+catColor(x.cat)+'"></span>'+
      '<span class="pt">'+esc(x.title)+(x.priority === 'high' ? '<small>High priority</small>' : '')+'</span>'+
      '<span class="when">'+esc((x.due ? (x.dateType === 'on' ? 'on ' : 'by ')+niceBy(x.due) : (x.repeat ? repeatLabel(x.repeat) : 'anytime')) + (x.mins ? ' · '+dur(x.mins) : ''))+'</span></div>'));
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
      h += '<div class="modal-actions"><button class="ghost" data-aiback>Back</button><span style="flex:1"></span><button class="go" data-aiapply>Add to my week</button></div>';
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
  let drag = null, noClick = false;
  app.addEventListener('pointerdown', e => {
    if (view !== 'week' || !expanded || editing || aiOpen) return;
    const cb = e.target.closest('.cb'); if (!cb) return;
    if (cb.classList.contains('cbstep')) return; // goal-step blocks aren't draggable
    const cols = app.querySelector('.calcols'); if (!cols) return;
    e.preventDefault();
    drag = {
      el: cb, uid: cb.dataset.uid, dk: cb.dataset.dk,
      s: +cb.dataset.sm, e: +cb.dataset.em, pos: +cb.dataset.pos,
      x: e.clientX, y: e.clientY,
      colW: (cols.clientWidth - 36) / 7 + 6,     // column centre-to-centre distance
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
      drag.newPos = Math.max(0, Math.min(6, drag.pos + Math.round(dx / drag.colW)));
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
          const monday = parseDay(weekKey(new Date()));
          const target = new Date(monday); target.setDate(monday.getDate() + drag.newPos);
          const newDk = dayKey(target);
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
    if (view !== 'day' || editing || settingsOpen || aiOpen || ob || e.touches.length !== 1){ swX = null; return; }
    swX = e.touches[0].clientX; swY = e.touches[0].clientY;
  }, { passive: true });
  app.addEventListener('touchend', e => {
    if (swX == null) return;
    const tp = e.changedTouches && e.changedTouches[0];
    const x = swX, y = swY; swX = null;
    if (!tp) return;
    const dx = tp.clientX - x, dy = tp.clientY - y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45){
      dayShift += (dx < 0 ? 1 : -1);   // swipe left = next day
      noClick = true;                  // swallow the click this gesture would fire
      render();
    }
  }, { passive: true });

  app.addEventListener('click', e => {
    if (noClick){ noClick = false; e.preventDefault(); return; }
    const now = new Date(), today = dayKey(now);
    const t = el => e.target.closest(el);
    let m;

    // auth
    if (t('[data-sendlink]')){ sendMagicLink(); return; }
    if (t('[data-signout]')){ if (sb) sb.auth.signOut().catch(()=>{}); settingsOpen = false; return; }

    // onboarding
    if (t('[data-obnext]')){ obSync(); ob.step = Math.min(3, ob.step + 1); render(); return; }
    if (t('[data-obback]')){ obSync(); ob.step = Math.max(0, ob.step - 1); render(); return; }
    if ((m = t('[data-obcat]'))){ obSync(); const id = m.dataset.obcat; const i = ob.cats.indexOf(id); if (i === -1) ob.cats.push(id); else ob.cats.splice(i, 1); render(); return; }
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
    if (t('[data-aiapply]')){ aiApply(); return; }
    if ((m = t('[data-aicopy]'))){
      const txt = aiPrompt();
      const done = () => { m.textContent = 'Copied ✓'; setTimeout(() => { if (m) m.textContent = 'Copy prompt'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, done); else done();
      return;
    }

    // editor / settings dismissal
    if (t('[data-closeeditor]')){ editing = null; clearModalDrafts(); render(); return; }
    if (t('[data-saveevent]')){ commitEvent(); return; }
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
    if (t('[data-toggledone]')){ showDone = !showDone; render(); return; }
    if (t('[data-addtask]')){
      const ti = (document.getElementById('tk_title') || {}).value || '';
      if (!ti.trim()) return;
      const rep = (document.getElementById('tk_rep') || {}).value || 'once';
      S.tasks = S.tasks || [];
      S.tasks.push({
        id: 'tk_'+uid8(), title: ti.trim().slice(0,140), note: '',
        cat: (document.getElementById('tk_cat') || {}).value || (S.categories[0]||{}).id,
        priority: (document.getElementById('tk_prio') || {}).value || 'normal',
        due: (document.getElementById('tk_due') || {}).value || null,
        dateType: (document.getElementById('tk_when') || {}).value || 'by',
        mins: +((document.getElementById('tk_mins') || {}).value || 0) || null,
        repeat: rep === 'once' ? null : { freq: rep, interval: 1 },
        createdAt: new Date().toISOString(), doneAt: null
      });
      clearDraft('tk_title'); clearDraft('tk_due');
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
    if ((m = t('[data-gotogoal]'))){ view = 'goals'; openGoal = m.dataset.gotogoal; render(); return; }
    if ((m = t('[data-newon]'))){ openEditor({ date: m.dataset.newon }); return; }

    if ((m = t('[data-view]'))){ view = m.dataset.view; openDay = null; render(); return; }
    if ((m = t('[data-shift]'))){ dayShift += +m.dataset.shift; openDay = null; render(); return; }
    if (t('[data-today]')){ dayShift = 0; openDay = null; render(); return; }
    if (t('[data-manageblocks]')){ manageBlocks = !manageBlocks; render(); return; }
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
    if ((m = t('[data-parkschedule]'))){
      const [i, dk] = m.dataset.parkschedule.split('|');
      const item = (S.parked || [])[+i];
      if (!item) return;
      openEditor({ date: dk, title: item.t, fromParked: +i });
      return;
    }
    if ((m = t('[data-unpark]'))){ markUndo('Thought cleared'); S.parked.splice(+m.dataset.unpark, 1); save(); render(); return; }
  });

  // Re-render the editor when repeat type or all-day toggles (to swap fields).
  app.addEventListener('change', e => {
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

  app.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'auth_email'){ e.preventDefault(); sendMagicLink(); return; }
    if (e.key === 'Enter' && e.target.id === 'ob_name'){ e.preventDefault(); obSync(); ob.step = 1; render(); return; }
    if (e.key === 'Enter' && e.target.id === 'sk'){
      e.preventDefault(); const v = e.target.value.trim();
      if (v){ S.parked.push({ t:v.slice(0,200) }); clearDraft('sk'); save(); render(); const i = document.getElementById('sk'); if (i) i.focus(); }
    }
    if (e.key === 'Enter' && e.target.id === 'tk_title'){ e.preventDefault(); const b = app.querySelector('[data-addtask]'); if (b) b.click(); return; }
    if (e.key === 'Escape' && (editing || settingsOpen || aiOpen || taskEdit)){ editing = null; taskEdit = null; settingsOpen = false; aiOpen = false; aiPreview = null; aiStep = 'input'; clearDraft('ai_ask'); clearModalDrafts(); render(); }
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

  function loginHTML(){
    let h = '<div class="login">';
    h += '<div class="login-mark">' + MOON + '</div>';
    h += '<h1>Athena</h1>';
    h += '<p class="login-sub">A calm place to plan your days. Sign in and it syncs across your phone and laptop.</p>';
    h += '<div class="login-box">'+
      '<input id="auth_email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="you@email.com">'+
      '<button class="go" data-sendlink'+(authBusy?' disabled':'')+'>'+(authBusy?'Sending…':'Email me a sign-in link')+'</button>'+
      '</div>';
    if (authMsg) h += '<p class="login-msg">' + esc(authMsg) + '</p>';
    h += '<p class="login-fine">No passwords. We email you a one-time link.</p>';
    h += '</div>';
    return h;
  }
  function renderAuth(){
    app.classList.remove('wide');
    app.innerHTML = loginHTML();
    const i = document.getElementById('auth_email');
    if (i && drafts['auth_email']) i.value = drafts['auth_email'];
  }
  async function sendMagicLink(){
    const i = document.getElementById('auth_email');
    const email = ((i && i.value) || '').trim();
    if (!email || email.indexOf('@') === -1){ authMsg = 'Enter a valid email address.'; renderAuth(); if (i) i.focus(); return; }
    if (!sb){ authMsg = 'Sign-in is not configured.'; renderAuth(); return; }
    authBusy = true; authMsg = ''; renderAuth();
    try {
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      authBusy = false;
      authMsg = error ? ('Could not send the link: ' + error.message)
                      : 'Check your email. A sign-in link is on its way to ' + email + '.';
    } catch(e){ authBusy = false; authMsg = 'Something went wrong. Please try again.'; }
    renderAuth();
  }

  function startApp(){
    if (started) return;
    started = true;
    load().then(() => {
      applyTheme();
      render();
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
    return !!(editing || settingsOpen || aiOpen || ob || taskEdit ||
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

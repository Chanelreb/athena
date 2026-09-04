(function () {
  'use strict';

  /* ==========================================================================
     Athena — personal life planner
     Data model v2: date-based events with recurrence, per-user (one JSON blob).
     Storage goes through the single `store` object below — swap it for Supabase
     in Phase B. See SPEC.md.
     ========================================================================== */

  const KEY = 'athena:v2';

  // Storage adapter. Falls back to localStorage; Phase B replaces this with
  // Supabase calls keyed by the logged-in user. This is the only I/O boundary.
  const store = (window.storage && window.storage.get) ? window.storage : {
    get: async (k) => {
      const v = localStorage.getItem(k);
      if (v === null) throw new Error('not found: ' + k);
      return { key: k, value: v };
    },
    set: async (k, v) => { localStorage.setItem(k, v); return { key: k, value: v }; },
    delete: async (k) => { localStorage.removeItem(k); return { key: k, deleted: true }; }
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
    profile: { name:'', timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone || ''), onboarded:false },
    categories: DEFAULT_CATS.map(c => Object.assign({}, c)),
    events: [],
    habits: [],
    goals: [],
    parked: [],
    completions: {}   // { 'YYYY-MM-DD': { <itemId>: true | <number> } }
  });

  let S = blank();
  let ok = true;
  let view = 'day';
  let openDay = null;                 // week strips: which day is expanded
  let openGoal = null;
  let expanded = (typeof window !== 'undefined' && window.innerWidth >= 900);
  let editing = null;                 // event-editor state, or null

  function firstRun(){
    // Seed a fresh install so it isn't empty. Marks onboarded so we don't reseed.
    S.events = seedEvents();
    S.habits = seedHabits();
    S.profile.onboarded = true;
  }

  async function load(){
    try {
      const r = await store.get(KEY);
      if (r && r.value) S = Object.assign(blank(), JSON.parse(r.value));
    } catch(e){ /* nothing stored yet */ }
    if (!S.profile) S.profile = blank().profile;
    if (!S.categories || !S.categories.length) S.categories = DEFAULT_CATS.map(c => Object.assign({}, c));
    if (!S.profile.onboarded && !(S.events || []).length) firstRun();
  }
  let tm = null;
  function save(){
    clearTimeout(tm);
    tm = setTimeout(async () => {
      try { const r = await store.set(KEY, JSON.stringify(S)); ok = !!r; }
      catch(e){ ok = false; }
    }, 250);
  }

  /* ---------- categories ---------- */
  const catOf = id => S.categories.find(c => c.id === id) || S.categories[0] || DEFAULT_CATS[0];
  const catColor = id => catOf(id).color;

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

  function weekView(now){
    const ORDER = [1,2,3,4,5,6,0];
    const monday = parseDay(weekKey(now));
    const dates = {}, blocksByDay = {}, LBL = {};
    ORDER.forEach((d,i) => {
      const dd = new Date(monday); dd.setDate(monday.getDate()+i);
      dates[d] = dd;
      blocksByDay[d] = eventsOnDate(dd).filter(b => !b.allDay);
      LBL[d] = SD[d] + ' ' + dd.getDate();
    });
    const t = now.getHours()*60 + now.getMinutes();
    const todayPos = ORDER.indexOf(now.getDay());
    const tot = {};
    let h = '';

    if (expanded){
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
          tot[b.c] = (tot[b.c]||0) + (mins(b.e) - mins(b.s));
          const col = catColor(b.c);
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
        tot[b.c] = (tot[b.c]||0) + (mins(b.e) - mins(b.s));
        segs += '<i style="left:'+((s-DS)/SPAN*100)+'%;width:'+((e-s)/SPAN*100)+'%;background:'+catColor(b.c)+'"></i>';
      });
      if (isToday && t >= DS && t <= DE) segs += '<span class="wnow" style="left:'+((t-DS)/SPAN*100)+'%"></span>';
      h += '<div class="wrow'+(isToday?' today':'')+'"><span class="wday">'+LBL[d]+'</span>'+
        '<button class="wbar" data-day="'+d+'">'+segs+'</button></div>';
      if (openDay === d){
        h += '<div class="wlist">' + (blocks.length ? blocks.map(b =>
          '<button class="wl" data-editinst="'+b.id+'|'+dayKey(dates[d])+'">'+
          '<span class="sw" style="background:'+catColor(b.c)+'"></span><span>'+esc(b.t)+'</span>'+
          '<em>'+clockOf(b.s)+'</em></button>').join('')
          : '<p class="park-empty" style="margin:0">Nothing on this day.</p>') +
          '<button class="wl wl-add" data-newon="'+dayKey(dates[d])+'">+ Add something</button></div>';
      }
    });
    h += weekTotals(tot);
    return h;
  }

  function dayRail(now){
    const t = now.getHours()*60 + now.getMinutes();
    const dk = dayKey(now);
    const all = eventsOnDate(now);
    const allDay = all.filter(b => b.allDay);
    const blocks = all.filter(b => !b.allDay);

    const items = [];
    blocks.forEach((b,i) => {
      items.push({ type:'block', b:b });
      const nx = blocks[i+1];
      if (nx){ const g = mins(nx.s) - mins(b.e); if (g >= 30) items.push({ type:'gap', from:mins(b.e), to:mins(nx.s), next:nx }); }
    });
    const openTotal = items.filter(x=>x.type==='gap').reduce((a,x)=>a+(x.to-x.from),0);
    const booked = blocks.reduce((a,b)=>a+(mins(b.e)-mins(b.s)),0);
    const split = {};
    blocks.forEach(b => { split[b.c] = (split[b.c]||0) + (mins(b.e)-mins(b.s)); });

    let h = '';
    if (booked){
      h += '<p class="slack">Today asks for <b>'+dur(booked)+'</b>, and leaves <b>'+dur(openTotal)+'</b> open in between. There is room.</p>';
      h += '<div class="balbar">' + S.categories.map(c =>
        split[c.id] ? '<i style="width:'+(split[c.id]/booked*100)+'%;background:'+c.color+'"></i>' : '').join('') + '</div>';
      h += '<div class="balkey">' + S.categories.filter(c=>split[c.id]).map(c =>
        '<span><b style="background:'+c.color+'"></b>'+esc(c.label)+' '+dur(split[c.id])+'</span>').join('') + '</div>';
    } else {
      h += '<p class="slack">Nothing scheduled today. <button class="linkish" data-newon="'+dk+'">Add something</button>, or enjoy the open day.</p>';
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
      const live = t >= mins(b.s) && t < mins(b.e);
      const past = t >= mins(b.e);
      const done = isDone(b.id, dk);
      const col = catColor(b.c);
      let dotStyle = '';
      if (done) dotStyle = 'background:'+col+';border-color:'+col;
      else if (live) dotStyle = 'background:var(--live);border-color:var(--live)';
      else if (!past) dotStyle = 'border-color:'+col;
      h += '<div class="item '+(live?'live':past?'past':'future')+(done?' done':'')+'">'+
        '<div class="clock">'+clockOf(b.s)+'</div>'+
        '<div class="track"><span class="dot" style="'+dotStyle+'">'+TICK+'</span></div>'+
        '<div class="card cardrow">'+
        '<button class="cardmain" data-done="'+b.id+'">'+
        '<div class="t">'+esc(b.t)+'</div>'+
        (b.n?'<div class="n">'+esc(b.n)+'</div>':'');
      if (live){
        const pct = ((t - mins(b.s)) / (mins(b.e) - mins(b.s))) * 100;
        h += '<div class="meter"><i style="width:'+pct.toFixed(1)+'%"></i></div>'+
          '<div class="left">'+dur(mins(b.e)-t)+' to go</div>';
      }
      h += '</button>'+
        '<button class="editdot" data-editinst="'+b.id+'|'+dk+'" aria-label="Edit">⋯</button>'+
        '</div></div>';
    });

    h += '<div class="dayadd"><button data-newon="'+dk+'">+ New event</button></div>';
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
        h += '<button class="chip'+(v>=d.target?' on':'')+'" style="'+(v>=d.target?tint:'')+'" data-pip="'+d.id+':'+d.target+'"><span class="cl">'+esc(d.l)+'</span><span class="pips">'+p+'</span></button>';
      } else {
        const on = isDone(d.id, dk);
        h += '<button class="chip'+(on?' on':'')+'" style="'+(on?tint:'')+'" data-done="'+d.id+'"><span class="cl">'+esc(d.l)+'</span>'+
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
    const freqText = st => st.freq === 'daily' ? 'Every day' : st.freq === 'weekly' ? 'Weekly' : 'Monthly';
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
          '</div>'+
          '<button class="go" data-addstep="'+g.id+'">Add step</button></div>';
        h += '<button class="del wide" data-delgoal="'+g.id+'">Remove this goal</button>';
        h += '</div>';
      }
    });
    h += '<h2>New goal</h2><div class="gform">'+
      '<input id="gt" type="text" placeholder="What are you building toward?" autocomplete="off">'+
      '<div class="frow"><input id="gb" type="date"><select id="gc">'+CATOPTS+'</select></div>'+
      '<button class="go" data-addgoal>Add goal</button></div>';
    h += '<p class="slack" style="padding-top:16px">Daily steps become everyday tick-offs. Weekly and monthly steps are tracked here against each period.</p>';
    return h;
  }

  /* ---------- parked thoughts ---------- */
  function parkHTML(){
    let h = '<div class="park"><div class="park-row">'+
      '<input id="sk" type="text" placeholder="Park a stray thought…" autocomplete="off">'+
      '<button data-park>Park</button></div>';
    h += (S.parked||[]).length
      ? '<ul class="parked">'+S.parked.map((p,i)=>'<li><span>'+esc(p.t)+'</span><button data-unpark="'+i+'" aria-label="Remove">×</button></li>').join('')+'</ul>'
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
        title: '', note: '', cat: (S.categories[0]||{}).id, allDay: false,
        start: '09:00', end: '10:00',
        repeat: 'once', weekdays: [D.getDay()], onceDate: dk, monthday: D.getDate()
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
  const MODAL_IDS = ['e_title','e_note','e_cat','e_allday','e_start','e_end','e_repeat','e_date','e_monthday','s_name'];
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

  function render(){
    const now = new Date();
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
      ['day','week','habits','goals'].map(v =>
        '<button data-view="'+v+'"'+(view===v?' class="on"':'')+'>'+v.charAt(0).toUpperCase()+v.slice(1)+'</button>').join('')+
      '</div>'+
      (view==='week' ? '<button class="expand" data-expand="1">'+(expanded?'Collapse to strips':'Expand to full grid')+'</button>' : '')+
      '</div>';
    app.classList.toggle('wide', view==='week' && expanded);

    if (view === 'day')    h += dayRail(now);
    else if (view === 'week')  h += weekView(now);
    else if (view === 'habits') h += habitsView(now);
    else if (view === 'goals')  h += goalsView(now);

    // parked thoughts + everyday chips live under the Day view
    if (view === 'day'){ h += parkHTML(); }

    h += '<footer>'+(ok?'Everything saves as you go, on this device. Accounts and sync are coming.':'Not saving right now.')+'</footer>';

    if (editing) h += editorHTML();
    if (settingsOpen) h += settingsHTML();

    paint(h);
  }

  /* ---------- settings (name + categories) ---------- */
  let settingsOpen = false;
  function settingsHTML(){
    let h = '<div class="modal-back" data-closesettings></div>';
    h += '<div class="modal"><div class="modal-h">Settings</div>';
    h += '<label class="fld"><span>Your name</span><input id="s_name" type="text" placeholder="What should Athena call you?" value="'+esc((S.profile&&S.profile.name)||'')+'" autocomplete="off"></label>';
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
    h += '<div class="modal-actions"><span style="flex:1"></span><button class="go" data-closesettings>Done</button></div>';
    h += '</div>';
    return h;
  }

  /* ==========================================================================
     Events / interaction
     ========================================================================== */

  // ----- desktop drag in the expanded grid: resize + vertical (time) move -----
  const GH = 680, GSPAN = SPAN;
  let drag = null, noClick = false;
  app.addEventListener('pointerdown', e => {
    if (view !== 'week' || !expanded || editing) return;
    const cb = e.target.closest('.cb'); if (!cb) return;
    e.preventDefault();
    drag = {
      el: cb, uid: cb.dataset.uid, dk: cb.dataset.dk,
      s: +cb.dataset.sm, e: +cb.dataset.em,
      y: e.clientY, resize: e.target.classList.contains('rz'), moved: false
    };
    drag.newS = drag.s; drag.newE = drag.e;
    cb.setPointerCapture(e.pointerId);
  });
  app.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 5) return;
    if (!drag.moved){ drag.moved = true; drag.el.classList.add('dragging'); }
    const pxMin = GH / GSPAN;
    const dm = Math.round((dy / pxMin) / 15) * 15;
    if (drag.resize){
      drag.newE = Math.min(DS + GSPAN, Math.max(drag.s + 15, drag.e + dm));
      drag.el.style.height = Math.max(20, (drag.newE - drag.s) * pxMin - 2) + 'px';
    } else {
      const len = drag.e - drag.s;
      drag.newS = Math.max(DS, Math.min(DS + GSPAN - len, drag.s + dm));
      drag.newE = drag.newS + len;
      drag.el.style.transform = 'translateY(' + ((drag.newS - drag.s) * pxMin) + 'px)';
    }
  });
  app.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.moved){
      const e = findEvent(drag.uid);
      if (e){ e.ex = e.ex || {}; e.ex[drag.dk] = Object.assign({}, e.ex[drag.dk], { start: fmtM(drag.newS), end: fmtM(drag.newE) }); }
      noClick = true; save(); drag = null; render(); return;
    }
    drag = null;
  });

  app.addEventListener('click', e => {
    if (noClick){ noClick = false; e.preventDefault(); return; }
    const now = new Date(), today = dayKey(now);
    const t = el => e.target.closest(el);
    let m;

    // editor / settings dismissal
    if (t('[data-closeeditor]')){ editing = null; clearModalDrafts(); render(); return; }
    if (t('[data-saveevent]')){ commitEvent(); return; }
    if ((m = t('[data-delevent]'))){ S.events = S.events.filter(x => x.id !== m.dataset.delevent); editing = null; clearModalDrafts(); save(); render(); return; }
    if ((m = t('[data-wd]'))){ syncEditor(); const d = +m.dataset.wd; const i = editing.weekdays.indexOf(d); if (i===-1) editing.weekdays.push(d); else editing.weekdays.splice(i,1); render(); return; }
    if (t('[data-settings]')){ clearModalDrafts(); settingsOpen = true; render(); return; }
    if (t('[data-closesettings]')){ commitSettings(); settingsOpen = false; clearModalDrafts(); render(); return; }
    if (t('[data-addcat]')){ commitSettings(); S.categories.push({ id:'c_'+uid8(), label:'New', color:'#B7B2BE' }); save(); render(); return; }
    if ((m = t('[data-delcat]'))){ commitSettings(); if (S.categories.length>1) S.categories = S.categories.filter(c=>c.id!==m.dataset.delcat); save(); render(); return; }

    // re-render editor when repeat/all-day changes handled in 'change' listener below

    if ((m = t('[data-editinst]'))){ const [id, dk] = m.dataset.editinst.split('|'); openEditor({ id, date: dk }); return; }
    if ((m = t('[data-newon]'))){ openEditor({ date: m.dataset.newon }); return; }

    if ((m = t('[data-view]'))){ view = m.dataset.view; openDay = null; render(); return; }
    if (t('[data-expand]')){ expanded = !expanded; render(); return; }
    if ((m = t('[data-day]'))){ const d = +m.dataset.day; openDay = (openDay === d) ? null : d; render(); return; }
    if ((m = t('[data-goal]'))){ const id = m.dataset.goal; openGoal = (openGoal === id) ? null : id; render(); return; }

    if ((m = t('[data-done]'))){ toggleDone(m.dataset.done, today); save(); render(); return; }
    if ((m = t('[data-pip]'))){ const [id, tg] = m.dataset.pip.split(':'); bumpCount(id, today, +tg); save(); render(); return; }
    if ((m = t('[data-step]'))){ const [gid, sid] = m.dataset.step.split(':'); toggleStep(gid, sid, now); save(); render(); return; }

    if (t('[data-addhabit]')){
      const lab = (document.getElementById('hl')||{}).value || '';
      if (!lab.trim()) return;
      clearDraft('hl');
      S.habits.push({ id:'hb_'+uid8(), label:lab.trim().slice(0,80),
        cat:(document.getElementById('hc')||{}).value || (S.categories[0]||{}).id,
        target:+((document.getElementById('hn')||{}).value || 1) });
      save(); render(); return;
    }
    if ((m = t('[data-delhabit]'))){ S.habits = S.habits.filter(x => x.id !== m.dataset.delhabit); save(); render(); return; }

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
      clearDraft('sl_'+gid);
      g.steps.push({ id:'st_'+uid8(), label:lab.trim().slice(0,120), freq:(document.getElementById('sf_'+gid)||{}).value||'weekly' });
      save(); render(); return;
    }
    if ((m = t('[data-delstep]'))){ const [gid, sid] = m.dataset.delstep.split(':'); const g = S.goals.find(x=>x.id===gid); if (g) g.steps = g.steps.filter(s=>s.id!==sid); save(); render(); return; }
    if ((m = t('[data-delgoal]'))){ S.goals = S.goals.filter(x=>x.id!==m.dataset.delgoal); if (openGoal===m.dataset.delgoal) openGoal=null; save(); render(); return; }

    if (t('[data-park]')){ const i = document.getElementById('sk'); const v = i && i.value.trim(); if (!v){ if (i) i.focus(); return; } S.parked.push({ t:v.slice(0,200) }); clearDraft('sk'); save(); render(); const j = document.getElementById('sk'); if (j) j.focus(); return; }
    if ((m = t('[data-unpark]'))){ S.parked.splice(+m.dataset.unpark, 1); save(); render(); return; }
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
    if (e.key === 'Enter' && e.target.id === 'sk'){
      e.preventDefault(); const v = e.target.value.trim();
      if (v){ S.parked.push({ t:v.slice(0,200) }); clearDraft('sk'); save(); render(); const i = document.getElementById('sk'); if (i) i.focus(); }
    }
    if (e.key === 'Escape' && (editing || settingsOpen)){ editing = null; settingsOpen = false; clearModalDrafts(); render(); }
  });

  load().then(() => {
    render();
    keepDrafts();
    setInterval(() => {
      const ae = document.activeElement;
      if (editing || settingsOpen) return;
      if (ae && app.contains && app.contains(ae) &&
          (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
      render();
    }, 60000);
  });
})();

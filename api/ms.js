// Athena's connection to Outlook and Microsoft 365 calendars.
//
// One endpoint, four jobs, chosen by `action`:
//   start    hand back the Microsoft sign-in URL to send the browser to
//   connect  swap the code Microsoft gave us for tokens, and remember them
//   events   what is actually in the calendar over a window of days
//   refresh  keep a connection alive (called by events, not from outside)
//
// Two things about the shape of this are deliberate.
//
// The tokens are exchanged here rather than in the browser, because that needs
// the client secret and a secret in a browser is not a secret. But we never ask
// Microsoft to send them here directly either: the callback bounces the
// short-lived authorisation code back to the app, and the app hands it to us
// along with its own Athena session. That way nothing has to carry an Athena
// session through Microsoft's redirect, and the code on its own is useless to
// anyone without the secret that lives only in Vercel.
//
// And every database read here goes through the caller's own Athena session,
// so this endpoint can only ever touch that person's rows. There is no master
// key anywhere in Athena and this was not the place to introduce one.
//
// Which leaves one gap worth closing. Reading as the caller means the browser
// could make exactly the same request and be handed the Microsoft tokens back,
// and a Microsoft refresh token is worth more than anything else in Athena: it
// reaches outside the app into a real mailbox and lasts for months. Column
// grants cannot help, because the browser and this endpoint arrive as the same
// person holding the same session. So the tokens are encrypted before they are
// stored. What the database holds, and what a browser could pull out of it, is
// ciphertext this endpoint is the only thing able to read.
//
// Needs two environment variables in Vercel: MS_CLIENT_ID and MS_CLIENT_SECRET.

import crypto from 'node:crypto';

const MS_ID = process.env.MS_CLIENT_ID || '';
const MS_SECRET = process.env.MS_CLIENT_SECRET || '';
// "common" is what lets one registration serve both a work tenant and a
// personal Hotmail account. A tenant-specific URL here would quietly lock out
// every personal account.
const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
/* What a fresh connection asks for. Calendars.ReadWrite is a bigger grant
   than Calendars.Read and Microsoft will show her so on the consent screen,
   which is correct: it is a bigger thing to agree to. */
const SCOPES = 'openid profile offline_access User.Read Calendars.ReadWrite';

/* The one calendar Athena is allowed to touch. Matched by name because that
   is the only handle that survives her deleting it and us making it again. */
const CAL_NAME = 'Athena';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubtumwzsaqcjxegklirp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_RO1Hl4ZETOTScUPvs0nD4w_xUdoYSLR';

const siteURL = () => process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL
  : 'https://theathena.app';
const redirectURI = () => siteURL() + '/api/ms/callback';

// The key is derived from the Microsoft client secret, which already lives in
// Vercel and nowhere else, so this costs no extra setup step. MS_TOKEN_KEY is
// there for later, if the two should ever stop being tied together. Rotating
// either one means reconnecting the calendars, which is a handful of taps and
// a rare event, and the code below says so plainly rather than failing oddly.
let keyCache = null;
function tokenKey(){
  if (keyCache) return keyCache;
  const src = process.env.MS_TOKEN_KEY || MS_SECRET;
  if (!src) return null;
  keyCache = crypto.scryptSync(src, 'athena.ms.tokens.v1', 32);
  return keyCache;
}
function seal(plain){
  const key = tokenKey();
  if (!key || !plain) return plain || null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + iv.toString('base64url') + '.' +
         c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
}
function unseal(stored){
  if (!stored || typeof stored !== 'string') return stored;
  if (stored.slice(0, 3) !== 'v1.') return stored; // never sealed, use as is
  const key = tokenKey();
  const bits = stored.split('.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(bits[1], 'base64url'));
    d.setAuthTag(Buffer.from(bits[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(bits[3], 'base64url')), d.final()]).toString('utf8');
  } catch (_){
    const e = new Error('This calendar was connected under a different Microsoft app secret, so Athena can no longer read it. Disconnect it and connect it again.');
    e.code = 'invalid_grant'; // same cure as a dead token: reconnect
    throw e;
  }
}

function bearer(req){
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7) : '';
}
async function signedInUser(token){
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_KEY }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (_){ return null; }
}

// Every query runs as the person who asked, so row level security does the
// work and this code never has to remember whose rows are whose.
async function db(token, path, init){
  // Headers are set last and on their own. Spreading init over an object that
  // already held them replaced the whole headers object with init's, which
  // threw away the key and the session on every call that passed a Prefer.
  const opts = Object.assign({}, init || {});
  opts.headers = Object.assign({
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token,
    'content-type': 'application/json'
  }, (init && init.headers) || {});
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_){ body = text; }
  if (!r.ok) throw new Error((body && body.message) || ('database said ' + r.status));
  return body;
}

async function msToken(form){
  const r = await fetch(MS_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({
      client_id: MS_ID, client_secret: MS_SECRET
    }, form)).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok){
    // Microsoft's descriptions are long but they are the only thing that says
    // which of a dozen setup steps was the wrong one, so they are passed on.
    const e = new Error(String(j.error_description || j.error || 'Microsoft refused that').slice(0, 300));
    e.code = j.error || '';
    throw e;
  }
  return j;
}

// An access token lasts about an hour. Rather than tracking that precisely,
// use the stored one while it has a couple of minutes left and otherwise spend
// the refresh token, which is what it is for.
async function usableToken(jwt, row){
  const now = Date.now();
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - now > 120000)
    return unseal(row.access_token);
  const t = await msToken({
    grant_type: 'refresh_token', refresh_token: unseal(row.refresh_token)
  });
  const expires = new Date(now + ((+t.expires_in || 3600) * 1000)).toISOString();
  await db(jwt, 'ms_accounts?id=eq.' + encodeURIComponent(row.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(Object.assign({
      access_token: seal(t.access_token), expires_at: expires
    }, t.refresh_token ? { refresh_token: seal(t.refresh_token) } : {}))
  });
  return t.access_token;
}

// Graph answers with a wall clock and the zone beside it, never joined up:
//   { dateTime: "2026-09-28T11:00:00.0000000", timeZone: "Australia/Perth" }
//
// Which zone to ask for is the whole question. UTC is the tempting answer and
// the wrong one: an all-day entry is midnight in its own zone, and rendered in
// UTC a Perth holiday on the 28th comes back stamped the 27th, so it lands on
// the wrong day. Asking for the reader's own zone instead makes both kinds
// right at once, because then the wall clock Graph sends is the wall clock
// they are actually living in, and the browser reads it as exactly that.
const tzOK = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const cleanTZ = z => (typeof z === 'string' && z.length <= 64 && tzOK.test(z)) ? z : 'UTC';

/* Athena's own calendar inside her Outlook, made the first time it is needed.
   Found by name, so if she deletes it in Outlook the next write makes a new
   one rather than failing on a remembered id that is not there any more. */
async function athenaCalendar(tok){
  const r = await fetch('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name&$top=200', {
    headers: { Authorization: 'Bearer ' + tok }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw graphError(r, j, 'list the calendars');
  const found = (j.value || []).find(c => String(c.name) === CAL_NAME);
  if (found) return found.id;
  const mk = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({ name: CAL_NAME })
  });
  const made = await mk.json().catch(() => ({}));
  if (!mk.ok) throw graphError(mk, made, 'make a calendar called ' + CAL_NAME);
  return made.id;
}

/* Graph says no in several ways and only one of them is worth acting on: a
   token that was granted before Athena could write. That is a reconnect, not
   a fault, and it has to be told apart from a genuine refusal. */
function graphError(r, j, doing){
  const said = (j && j.error && (j.error.message || j.error.code)) || '';
  const e = new Error('Microsoft would not ' + doing + (said ? ': ' + said : '') + '.');
  if (r.status === 403 || /ErrorAccessDenied|insufficient|scope/i.test(said)) e.needsWrite = true;
  e.status = r.status;
  return e;
}

/* Every write goes through here, and the calendar id is never a parameter:
   it is resolved from the token each time. An event is addressed through
   /me/calendars/{athena}/events/{id}, so anything that lives in her real
   diary simply is not found, which is the behaviour we want and not a check
   we have to remember to write. */
async function inAthena(tok, path, init){
  const cal = await athenaCalendar(tok);
  const url = 'https://graph.microsoft.com/v1.0/me/calendars/' + cal + '/events' + (path || '');
  const r = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      (init && init.headers) || {})
  }));
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw graphError(r, j, 'write to the ' + CAL_NAME + ' calendar');
  return j;
}

const wall = t => (t && t.dateTime) ? String(t.dateTime) : null;

// An all-day entry has no clock to convert. Taking its date straight off the
// string keeps it on the day Outlook says, instead of sliding a day either way
// depending on which side of Greenwich you are.
const dayOf = t => (t && t.dateTime) ? String(t.dateTime).slice(0, 10) : null;

export default async function handler(req, res){
  // Microsoft only ever arrives here one way: a GET carrying the code. It is
  // handed straight back to the app rather than acted on, so that nothing has
  // to carry an Athena session through somebody else's redirect.
  if (req.method === 'GET'){
    const u = new URL(req.url, siteURL());
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state') || '';
    const back = new URL(siteURL());
    if (err){
      back.searchParams.set('mserror', String(u.searchParams.get('error_description') || err).slice(0, 300));
    } else if (code){
      back.searchParams.set('mscode', code);
      back.searchParams.set('msstate', state);
    } else {
      back.searchParams.set('mserror', 'Microsoft sent us back without an answer.');
    }
    res.writeHead(302, { Location: back.toString() });
    res.end();
    return;
  }

  if (req.method !== 'POST'){ res.status(405).json({ error: 'Use POST.' }); return; }
  if (!MS_ID || !MS_SECRET){
    res.status(503).json({ error: 'Calendars are not set up on the server yet. The Microsoft app details are missing in Vercel.' });
    return;
  }

  const jwt = bearer(req);
  const user = await signedInUser(jwt);
  if (!user){ res.status(401).json({ error: 'Please sign in again, then try once more.' }); return; }

  let body = req.body;
  if (typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
  body = body || {};
  const action = String(body.action || '');

  try {
    if (action === 'start'){
      const state = String(body.state || '').slice(0, 120);
      const url = new URL(MS_AUTH);
      url.searchParams.set('client_id', MS_ID);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectURI());
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', SCOPES);
      url.searchParams.set('state', state);
      // Always ask, so a second calendar can be added without Microsoft
      // silently signing you back in as the first one.
      url.searchParams.set('prompt', 'select_account');
      res.status(200).json({ url: url.toString() });
      return;
    }

    if (action === 'connect'){
      const code = String(body.code || '');
      if (!code){ res.status(400).json({ error: 'No code to exchange.' }); return; }
      const t = await msToken({
        grant_type: 'authorization_code', code, redirect_uri: redirectURI(), scope: SCOPES
      });
      if (!t.refresh_token){
        res.status(502).json({ error: 'Microsoft did not send a lasting connection. Check that offline_access is in the app permissions.' });
        return;
      }
      const who = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: 'Bearer ' + t.access_token }
      }).then(r => r.json()).catch(() => ({}));
      const label = String(who.userPrincipalName || who.mail || who.displayName || 'Microsoft account').slice(0, 120);
      const msId = String(who.id || label);
      const expires = new Date(Date.now() + ((+t.expires_in || 3600) * 1000)).toISOString();
      // on_conflict means reconnecting the same calendar updates it rather
      // than leaving a dead row beside a live one.
      await db(jwt, 'ms_accounts?on_conflict=user_id,ms_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: user.id, ms_id: msId, label,
          refresh_token: seal(t.refresh_token), access_token: seal(t.access_token), expires_at: expires
        })
      });
      res.status(200).json({ ok: true, label });
      return;
    }

    if (action === 'events'){
      const from = String(body.from || '').slice(0, 40);
      const to = String(body.to || '').slice(0, 40);
      const tz = cleanTZ(body.tz);
      if (!from || !to){ res.status(400).json({ error: 'Need a window of dates.' }); return; }
      const rows = await db(jwt, 'ms_accounts?select=id,label,refresh_token,access_token,expires_at');
      if (!rows || !rows.length){ res.status(200).json({ events: [], trouble: [], tz }); return; }

      const events = [], trouble = [];
      for (const row of rows){
        try {
          const tok = await usableToken(jwt, row);
          const q = new URLSearchParams({
            startDateTime: from, endDateTime: to,
            '$select': 'subject,start,end,isAllDay,showAs,location,webLink',
            '$orderby': 'start/dateTime', '$top': '100'
          });
          const r = await fetch('https://graph.microsoft.com/v1.0/me/calendarView?' + q.toString(), {
            headers: { Authorization: 'Bearer ' + tok, Prefer: 'outlook.timezone="' + tz + '"' }
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((j.error && j.error.message) || 'Microsoft would not hand over the calendar');
          (j.value || []).forEach(ev => {
            events.push({
              id: ev.id, from: row.label,
              title: String(ev.subject || '(no title)').slice(0, 160),
              start: wall(ev.start), end: wall(ev.end),
              day: ev.isAllDay ? dayOf(ev.start) : null,
              allDay: !!ev.isAllDay,
              // "free" and "working elsewhere" are not really busy, and treating
              // them as blocked time would make a clear day look full.
              busy: ev.showAs !== 'free' && ev.showAs !== 'workingElsewhere',
              where: (ev.location && String(ev.location.displayName || '').slice(0, 80)) || ''
            });
          });
        } catch(e){
          trouble.push({ account: row.label, why: (e && e.message) || 'could not be read' });
        }
      }
      // The zone is sent back so the browser knows how to read the clocks it
      // has just been handed, and knows to ask again if it ever moves.
      res.status(200).json({ events, trouble, tz });
      return;
    }

    /* Which account Athena writes through. With one connected there is no
       question; with several, writing to whichever happened to be first is
       how a work meeting ends up in a personal calendar, so it has to be
       named and the server refuses to pick. */
    async function writeRow(){
      const rows = await db(jwt, 'ms_accounts?select=id,label,ms_id,refresh_token,access_token,expires_at');
      if (!rows || !rows.length){ const e = new Error('No calendar is connected yet.'); e.status = 400; throw e; }
      const want = String(body.account || '');
      if (want){
        const hit = rows.find(r => String(r.ms_id) === want || String(r.id) === want);
        if (!hit){ const e = new Error('That calendar is not connected any more.'); e.status = 400; throw e; }
        return hit;
      }
      if (rows.length > 1){
        const e = new Error('More than one calendar is connected, so Athena needs telling which one to write to.');
        e.status = 400; throw e;
      }
      return rows[0];
    }

    /* Does this connection have the newer permission yet? Asked by trying the
       cheapest thing that needs it. Anything she connected before today said
       yes to reading and nothing else, and the honest answer is to say so and
       offer the screen again rather than to fail at the moment she presses a
       button expecting something to happen. */
    if (action === 'canwrite'){
      const row = await writeRow();
      try {
        const tok = await usableToken(jwt, row);
        const id = await athenaCalendar(tok);
        res.status(200).json({ ok: true, account: row.label, calendar: CAL_NAME, calendarId: id });
      } catch (e){
        if (e.needsWrite){
          res.status(200).json({ ok: false, account: row.label, needsWrite: true });
          return;
        }
        throw e;
      }
      return;
    }

    /* Put one event into the Athena calendar, or change one already there.
       Times are a wall clock and a zone, the same pair Graph hands back when
       reading, so nothing has to be converted on the way out and be wrong
       by an hour twice a year. */
    if (action === 'put'){
      const row = await writeRow();
      const tok = await usableToken(jwt, row);
      const title = String(body.title || '').trim().slice(0, 200);
      const start = String(body.start || '').slice(0, 30);
      const end = String(body.end || '').slice(0, 30);
      const tz = cleanTZ(body.tz);
      const msId = String(body.msId || '').slice(0, 300);
      if (!title || !start || !end){ res.status(400).json({ error: 'An event needs a name and a time.' }); return; }
      const ev = {
        subject: title,
        body: { contentType: 'text', content: String(body.note || '').slice(0, 2000) },
        start: { dateTime: start, timeZone: tz },
        end: { dateTime: end, timeZone: tz },
        isAllDay: !!body.allDay,
        showAs: 'busy',
        // Nobody is invited and nothing is sent. This is a note to herself
        // about her own time, and an event that emails her colleagues would
        // be a different and much larger thing to agree to.
        isReminderOn: false
      };
      const out = msId
        ? await inAthena(tok, '/' + encodeURIComponent(msId), { method: 'PATCH', body: JSON.stringify(ev) })
        : await inAthena(tok, '', { method: 'POST', body: JSON.stringify(ev) });
      res.status(200).json({ ok: true, msId: out.id || msId, account: row.label, calendar: CAL_NAME });
      return;
    }

    /* And take one out again. Addressed through the Athena calendar, so an id
       belonging to anything in her real diary is simply not found here. */
    if (action === 'drop'){
      const row = await writeRow();
      const tok = await usableToken(jwt, row);
      const msId = String(body.msId || '').slice(0, 300);
      if (!msId){ res.status(400).json({ error: 'Nothing to remove.' }); return; }
      try {
        await inAthena(tok, '/' + encodeURIComponent(msId), { method: 'DELETE' });
      } catch (e){
        // Already gone is the outcome asked for, so it is not an error.
        if (e.status !== 404) throw e;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (e){
    const msg = (e && e.message) || 'Something went wrong talking to Microsoft.';
    // A refresh token that has been revoked or expired is the one failure the
    // app can actually act on, so it is named rather than lumped in.
    const dead = /invalid_grant|AADSTS70008|AADSTS50173/i.test(msg) || e.code === 'invalid_grant';
    // Connected before Athena could write, so the grant it holds is a reading
    // one. Nothing is broken; she has simply not been asked yet.
    if (e.needsWrite && !dead){
      res.status(403).json({ error: msg, needsWrite: true });
      return;
    }
    res.status(e.status === 400 ? 400 : (dead ? 409 : 502)).json({ error: msg, reconnect: dead });
  }
}

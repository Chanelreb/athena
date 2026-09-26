// Athena's nudges.
//
// Two jobs, one endpoint:
//   GET   hands the browser the public half of the push key pair, so the key
//         never has to be written into app.js and can be rotated in Vercel
//         alone.
//   POST  is the delivery run. Supabase wakes once a minute, works out which
//         notifications are due, and posts them here with a shared secret. This
//         encrypts and sends each one.
//
// Why the work is split this way: the schedule lives in Supabase because that
// is the only part of Athena that is awake when nobody has the app open, and
// the sending lives here because Postgres cannot do the encryption that the
// Web Push protocol requires. Nothing here decides *when* anything fires, and
// nothing here knows what a block or a task is. It is a post box.
//
// Requires three environment variables in Vercel:
//   VAPID_PUBLIC   VAPID_PRIVATE   PUSH_CRON_SECRET

import webpush from 'web-push';

const PUBLIC = process.env.VAPID_PUBLIC || '';
const PRIVATE = process.env.VAPID_PRIVATE || '';
const SECRET = process.env.PUSH_CRON_SECRET || '';
// Push services want a way to contact whoever is sending. A URL is allowed and
// is less personal than an email address.
const SUBJECT = process.env.VAPID_SUBJECT || 'https://athena-eight-alpha.vercel.app';

let ready = false;
function arm(){
  if (ready) return true;
  if (!PUBLIC || !PRIVATE) return false;
  webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
  ready = true;
  return true;
}

export default async function handler(req, res){
  if (req.method === 'GET'){
    // Not a secret: this half is meant to be in every browser that subscribes.
    if (!PUBLIC){ res.status(503).json({ error: 'Push is not set up yet.' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ key: PUBLIC });
    return;
  }
  if (req.method !== 'POST'){ res.status(405).json({ error: 'Use GET or POST.' }); return; }

  // The only caller is the scheduled job. Without this, anyone who found the
  // URL could send whatever they liked to whoever happened to be subscribed.
  if (!SECRET || req.headers['x-athena-cron'] !== SECRET){
    res.status(401).json({ error: 'Not for you.' });
    return;
  }
  if (!arm()){ res.status(503).json({ error: 'Push keys are missing.' }); return; }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  if (!items.length){ res.status(200).json({ sent: 0, failed: 0, gone: 0 }); return; }

  let sent = 0, failed = 0, gone = 0;
  await Promise.all(items.map(async (it) => {
    if (!it || !it.endpoint || !it.p256dh || !it.auth){ failed++; return; }
    const payload = JSON.stringify({
      title: String(it.title || 'Athena').slice(0, 120),
      body: String(it.body || '').slice(0, 300),
      tag: String(it.tag || 'athena').slice(0, 60),
      url: String(it.url || './').slice(0, 200),
      // Not sent by anything yet. The queue gains a column for it when the
      // must-not-miss deadlines land, and the service worker already knows
      // what to do with it, so that change is one SQL statement rather than a
      // new deploy on every side at once.
      urgent: !!it.urgent
    });
    try {
      await webpush.sendNotification(
        { endpoint: it.endpoint, keys: { p256dh: it.p256dh, auth: it.auth } },
        payload,
        { TTL: 600 }        // ten minutes: a late nudge is worse than none
      );
      sent++;
    } catch (e){
      // 404 and 410 mean that subscription is dead for good. Worth counting so
      // it shows up in the logs, but the tidy-up happens in Supabase, which is
      // the only side that knows whose subscription it was.
      if (e && (e.statusCode === 404 || e.statusCode === 410)) gone++;
      else failed++;
    }
  }));

  res.status(200).json({ sent, failed, gone });
}

function safeParse(s){ try { return JSON.parse(s); } catch(_){ return {}; } }

// Athena's built-in assistant.
//
// Turns a plain-language brain dump into the same JSON shape the paste flow
// already understands, so the browser can reuse its existing preview and apply
// pipeline unchanged. Structured outputs guarantee the shape, so there is no
// prose-or-JSON guessing here.
//
// Requires one environment variable in Vercel: ANTHROPIC_API_KEY.
// The Supabase values below are public (they ship in the browser already) and
// are only used to confirm the caller is a signed-in Athena user, so that this
// endpoint cannot be used by strangers to spend the API budget.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

/* Which model does the sorting. Haiku by default: turning "buy milk, dentist
   Tuesday 2pm" into a tidy list is extraction, not hard thinking, and with a
   household using this the difference in cost is the whole story. Override with
   ATHENA_MODEL in Vercel to try a bigger one without touching the code.

   Haiku 4.5 supports structured outputs, which is what keeps the reply the right
   shape, but it does not accept `effort`. That is a 400, not a polite ignore,
   so the field is only sent to models that take it. */
const MODEL = process.env.ATHENA_MODEL || 'claude-haiku-4-5-20251001';
const EFFORT_OK = /^claude-(opus-(5|4-8|4-7|4-6|4-5)|sonnet-(5|4-6)|fable-5|mythos-5)/;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubtumwzsaqcjxegklirp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_RO1Hl4ZETOTScUPvs0nD4w_xUdoYSLR';

// Nullable rather than optional: strict structured outputs want every key
// present, and the browser already treats null as "not given".
const Event = z.object({
  title: z.string(),
  category: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'fortnightly', 'monthly']).nullable(),
  weekdays: z.array(z.number()).nullable(),
  date: z.string().nullable(),
  note: z.string().nullable()
});
const Task = z.object({
  title: z.string(),
  category: z.string().nullable(),
  priority: z.enum(['high', 'normal', 'low']).nullable(),
  due: z.string().nullable(),
  dateType: z.enum(['by', 'on']).nullable(),
  minutes: z.number().nullable(),
  at: z.string().nullable(),
  repeat: z.enum(['once', 'daily', 'weekly', 'monthly']).nullable(),
  note: z.string().nullable()
});
const Habit = z.object({
  label: z.string(),
  category: z.string().nullable(),
  timesPerDay: z.number().nullable()
});
const Goal = z.object({
  title: z.string(),
  targetDate: z.string().nullable(),
  category: z.string().nullable(),
  steps: z.array(z.object({
    label: z.string(),
    freq: z.enum(['daily', 'weekly', 'monthly']).nullable()
  }))
});
const Plan = z.object({
  events: z.array(Event),
  tasks: z.array(Task),
  habits: z.array(Habit),
  goals: z.array(Goal)
});

async function signedInUser(req){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
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

export default async function handler(req, res){
  if (req.method !== 'POST'){
    res.status(405).json({ error: 'Use POST.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY){
    res.status(503).json({ error: 'The built-in assistant is not configured yet.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string'){ try { body = JSON.parse(body); } catch (_){ body = {}; } }
  const ask = String((body && body.ask) || '').trim().slice(0, 3000);
  const categories = String((body && body.categories) || '').slice(0, 400);
  const today = String((body && body.today) || '').slice(0, 10);
  if (!ask){
    res.status(400).json({ error: 'Tell me what to add first.' });
    return;
  }

  const user = await signedInUser(req);
  if (!user){
    res.status(401).json({ error: 'Please sign in again, then try once more.' });
    return;
  }

  const system = [
    'You turn a person\'s plain-language notes into entries for their planner, Athena.',
    'Events are things with a time of day. Tasks are things to finish; give each a category and a priority.',
    'On a task, dateType says what its date means: "on" if it must happen that day, "by" if it only has to be done by then. Default to "by".',
    'minutes is a rough estimate of how long a task takes, so it can be fitted into a block. Estimate it when you reasonably can.',
    'at is an "HH:MM" time, and only for a task that must happen at a set time, like an appointment. Use null for everything else: most tasks have no time and Athena places them itself.',
    'Habits are small daily things worth a streak. Goals are bigger, with a target date and repeatable steps.',
    'Their categories are: ' + (categories || 'Personal, Work, Health') + '. Use exactly these names.',
    'Today is ' + (today || new Date().toISOString().slice(0, 10)) + '. Resolve relative dates like "Friday" against it.',
    'Put an item in only one list. Use null for anything not given, and return empty arrays for lists with nothing in them.',
    'Do not invent detail the person did not imply.'
  ].join(' ');

  try {
    const client = new Anthropic();   // reads ANTHROPIC_API_KEY
    const output_config = { format: zodOutputFormat(Plan) };
    // effort is only accepted on some models, and Haiku is not one of them:
    // sending it there is a 400, not a polite ignore. Only add it when the
    // model in use actually supports it.
    if (EFFORT_OK.test(MODEL)) output_config.effort = 'low';
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system,
      output_config,
      messages: [{ role: 'user', content: ask }]
    });

    if (response.stop_reason === 'refusal'){
      res.status(422).json({ error: 'The assistant declined that one. Try rewording it.' });
      return;
    }
    const plan = response.parsed_output;
    if (!plan){
      res.status(502).json({ error: 'The assistant replied in an unexpected shape. Please try again.' });
      return;
    }
    // Hand back the same JSON text the paste flow expects, so the browser's
    // existing preview and apply path needs no special case.
    res.status(200).json({ text: JSON.stringify(plan) });
  } catch (err){
    if (err instanceof Anthropic.AuthenticationError){
      res.status(503).json({ error: 'The assistant key looks wrong. Check it in Vercel.' });
    } else if (err instanceof Anthropic.RateLimitError){
      res.status(429).json({ error: 'Too many requests just now. Give it a moment.' });
    } else if (err instanceof Anthropic.APIError){
      // Pass the wording through. A 400 here is almost always a model name or a
      // parameter that model does not take, and "could not be reached (400)"
      // sends you looking at your wifi. The message never contains the key.
      res.status(502).json({
        error: 'The assistant could not be reached (' + err.status + '). ' +
          ((err.message || '').slice(0, 300) || '') + ' Model: ' + MODEL
      });
    } else {
      res.status(500).json({ error: 'Something went wrong reaching the assistant.' });
    }
  }
}

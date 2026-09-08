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
    'Habits are small daily things worth a streak. Goals are bigger, with a target date and repeatable steps.',
    'Their categories are: ' + (categories || 'Personal, Work, Health') + '. Use exactly these names.',
    'Today is ' + (today || new Date().toISOString().slice(0, 10)) + '. Resolve relative dates like "Friday" against it.',
    'Put an item in only one list. Use null for anything not given, and return empty arrays for lists with nothing in them.',
    'Do not invent detail the person did not imply.'
  ].join(' ');

  try {
    const client = new Anthropic();   // reads ANTHROPIC_API_KEY
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 8000,
      system,
      output_config: {
        format: zodOutputFormat(Plan),
        effort: 'low'          // this is straightforward extraction, not hard reasoning
      },
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
      res.status(502).json({ error: 'The assistant could not be reached (' + err.status + ').' });
    } else {
      res.status(500).json({ error: 'Something went wrong reaching the assistant.' });
    }
  }
}

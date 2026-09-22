// Athena's built-in assistant.
//
// Three jobs, one endpoint, chosen by `mode`:
//   (none)     a brain dump turned into events, tasks, habits and goals
//   ask        one box for anything: adds things, answers questions about
//              the week, or proposes changes to what is already there
//   goalAsk    the questions nobody can guess about a goal
//   goalPlan   that goal written SMART and broken into a plan
//
// Each returns JSON the browser's existing preview and apply path understands.
// Structured outputs guarantee the shape, so there is no prose-or-JSON guessing
// here.
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

/* Every field is required and plainly typed, with an empty value meaning "not
   given": "" for text, 0 for numbers, [] for lists.

   This started as `.nullable()` everywhere, which reads better but makes each
   field a union, and the API caps a schema at 16 union-typed parameters to keep
   compilation cheap. This one had twenty and was rejected outright. Empty
   sentinels remove every union, and cost nothing: the browser importer already
   treats a falsy value as absent, which is what it did with null anyway. */
/* Category is offered as a choice from the person's own list whenever we have
   one. As a free string the model could answer "Admin" to someone whose
   category is "Life admin", and the browser then quietly filed it under their
   first category. That is how a whole import once landed in one Focus block.

   Be clear about what this does and does not do: the SDK's zod helper turns an
   enum into a plain string with the allowed values written into its
   description, so the model is told the list but not strictly held to it. The
   real safety net is in the browser, which flags any category that does not
   match and asks before anything lands.

   Each field gets its own copy. Reusing one schema object makes the helper
   hoist it into a $ref, which the schema that is known to work never used. */
export function planSchema(cats){
  const Cat = () => cats.length ? z.enum(cats) : z.string();
  const Event = z.object({
    title: z.string(),
    category: Cat(),
    start: z.string(),
    end: z.string(),
    repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'fortnightly', 'monthly']),
    weekdays: z.array(z.number()),
    date: z.string(),
    note: z.string()
  });
  const Task = z.object({
    title: z.string(),
    category: Cat(),
    priority: z.enum(['high', 'normal', 'low']),
    due: z.string(),
    dateType: z.enum(['by', 'on']),
    minutes: z.number(),
    at: z.string(),
    repeat: z.enum(['once', 'daily', 'weekly', 'monthly']),
    note: z.string()
  });
  const Habit = z.object({
    label: z.string(),
    category: Cat(),
    timesPerDay: z.number()
  });
  const Goal = z.object({
    title: z.string(),
    targetDate: z.string(),
    category: Cat(),
    steps: z.array(z.object({
      label: z.string(),
      freq: z.enum(['daily', 'weekly', 'monthly'])
    }))
  });
  return z.object({
    events: z.array(Event),
    tasks: z.array(Task),
    habits: z.array(Habit),
    goals: z.array(Goal)
  });
}

/* One box, three possible answers, one schema.

   It would read better as a union of three shapes, and it cannot be: the API
   caps a schema at sixteen union-typed parameters, and a union of three
   object shapes blows straight past it. So intent says which of the fields
   actually matter and the rest come back empty, which is the same bargain the
   import schema already makes and for the same reason.

   A change is flat and deliberately narrow. category and priority are plain
   strings rather than enums because they are only filled in on two of the ten
   actions, and the browser checks them against the real list anyway. Nothing
   here is trusted: every change is matched against a real id, shown as a tick
   box, and dropped if the browser cannot carry it out. */
export function anythingSchema(cats){
  const Cat = () => cats.length ? z.enum(cats) : z.string();
  return z.object({
    intent: z.enum(['add', 'answer', 'change']),
    reply: z.string(),
    events: z.array(z.object({
      title: z.string(), category: Cat(), start: z.string(), end: z.string(),
      repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'fortnightly', 'monthly']),
      weekdays: z.array(z.number()), date: z.string(), note: z.string()
    })),
    tasks: z.array(z.object({
      title: z.string(), category: Cat(), priority: z.enum(['high', 'normal', 'low']),
      due: z.string(), dateType: z.enum(['by', 'on']), minutes: z.number(),
      at: z.string(), repeat: z.enum(['once', 'daily', 'weekly', 'monthly']), note: z.string()
    })),
    habits: z.array(z.object({ label: z.string(), category: Cat(), timesPerDay: z.number() })),
    goals: z.array(z.object({
      title: z.string(), targetDate: z.string(), category: Cat(),
      steps: z.array(z.object({ label: z.string(), freq: z.enum(['daily', 'weekly', 'monthly']) }))
    })),
    changes: z.array(z.object({
      target: z.enum(['event', 'task', 'goal', 'routine', 'habit']),
      id: z.string(),
      action: z.enum(['move', 'retime', 'rename', 'recategorise', 'setdue',
        'setminutes', 'setpriority', 'done', 'skip', 'delete']),
      date: z.string(), start: z.string(), end: z.string(),
      title: z.string(), category: z.string(), priority: z.string(),
      minutes: z.number(), why: z.string()
    }))
  });
}

/* What Athena asks before it plans a goal. Six at most, and a question with a
   short list of answers is a tap rather than typing, which is what keeps six
   from feeling like a form. */
export function askSchema(){
  return z.object({
    smart: z.string(),
    questions: z.array(z.object({
      label: z.string(),
      placeholder: z.string(),
      kind: z.enum(['text', 'date', 'number']),
      options: z.array(z.string())
    }))
  });
}

/* The plan itself. Flat rather than nested: the measure and the routine are
   spelled out field by field, which keeps every property plainly typed and the
   union count at zero, for the same reason the schema above uses sentinels. */
export function goalSchema(cats){
  const Cat = () => cats.length ? z.enum(cats) : z.string();
  return z.object({
    title: z.string(),
    why: z.string(),
    category: Cat(),
    targetDate: z.string(),
    measureLabel: z.string(),
    measureUnit: z.string(),
    measureStart: z.number(),
    measureTarget: z.number(),
    milestones: z.array(z.object({ label: z.string(), by: z.string() })),
    routineName: z.string(),
    routineTime: z.string(),
    routineWeekdays: z.array(z.number()),
    routineHabits: z.array(z.string()),
    steps: z.array(z.object({
      label: z.string(),
      freq: z.enum(['daily', 'weekly', 'monthly']),
      weekday: z.number(),
      time: z.string()
    })),
    tasks: z.array(z.object({
      title: z.string(),
      due: z.string(),
      minutes: z.number(),
      priority: z.enum(['high', 'normal', 'low'])
    })),
    note: z.string()
  });
}

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
  const mode = String((body && body.mode) || '').slice(0, 20);
  const answers = String((body && body.answers) || '').slice(0, 1500);
  // The brief is the whole picture: their words, every answer, and the shape of
  // the week the plan has to fit into. Longer than an answer list, and worth it.
  const brief = String((body && body.brief) || '').slice(0, 4000);
  // The one box gets a picture of the whole week, with ids, so it can answer
  // questions about it and point at the exact thing to change. Much longer
  // than a goal brief, and there is no way round that.
  const week = String((body && body.week) || '').slice(0, 14000);
  const categories = String((body && body.categories) || '').slice(0, 400);
  const catNames = Array.from(new Set(categories.split(',').map(s => s.trim()).filter(Boolean))).slice(0, 30);
  const today = String((body && body.today) || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!ask){
    res.status(400).json({ error: 'Tell me what to add first.' });
    return;
  }

  const user = await signedInUser(req);
  if (!user){
    res.status(401).json({ error: 'Please sign in again, then try once more.' });
    return;
  }

  const listSystem = [
    'You turn a person\'s plain-language notes into entries for their planner, Athena.',
    'Events are things with a time of day. Tasks are things to finish; give each a category and a priority.',
    'On a task, dateType says what its date means: "on" if it must happen that day, "by" if it only has to be done by then. Default to "by".',
    'minutes is a rough estimate of how long a task takes, so it can be fitted into a block. Estimate it when you reasonably can.',
    'at is an "HH:MM" time, and only for a task that must happen at a set time, like an appointment. Leave it empty otherwise: most tasks have no time and Athena places them itself.',
    'Habits are small daily things worth a streak. Goals are bigger, with a target date and repeatable steps.',
    'Their categories are: ' + (categories || 'Personal, Work, Health') + '. Use exactly these names.',
    'Today is ' + today + '. Resolve relative dates like "Friday" against it.',
    'Put an item in only one list. Return empty lists for anything with nothing in it.',
    'Every field must be present. Where something was not given, use an empty value rather than inventing one: "" for text, 0 for numbers, [] for lists.',
    'Where a field must be one of a fixed set and nothing was said, choose the ordinary one: priority "normal", repeat "once", dateType "by", step freq "weekly".',
    'Dates are "YYYY-MM-DD" and times are "HH:MM" on a 24 hour clock.',
    'Do not invent detail the person did not imply.'
  ].join(' ');

  const askSystem = [
    'You help someone turn a vague goal into a SMART one: specific, measurable, achievable, relevant and time bound.',
    'Put the sharpest version you can manage in "smart", as one short sentence in their own kind of words.',
    'Then ask four to six questions: enough to plan properly, never so many it becomes a form. Ask nothing you can already tell from what they wrote.',
    'Cover the ground that changes the plan: what success looks like as a number, by when, how much time a week they have, which days or times of day actually suit them, what has stopped them before, and what they already have or still need (equipment, money, someone else involved).',
    'Order them so the two that matter most come first, in case they answer only those.',
    'You may be given a brief holding what has already been asked and answered. When you are, ask a further one to four questions on ground nobody has covered yet, never a reword of a question already there, and never something they have already answered. Go deeper: the specifics of how they will actually do it, what could derail it, and what support or kit it needs.',
    'Each question must be answerable in a few words. Keep the wording warm and plain, like a person who is interested, never a form field.',
    'kind is "date" for a date, "number" for a number, and "text" otherwise.',
    'When the sensible answers are a short list, put two to six of them in options and leave placeholder empty: choosing beats typing on a phone. Otherwise leave options empty and put a short example answer in placeholder.',
    'Today is ' + today + '.'
  ].join(' ');

  const goalPlanSystem = [
    'You turn a goal into a plan inside Athena, a personal planner.',
    'Write it SMART. title is the goal itself, short, specific and measurable, in their words. why is one line on why it matters to them.',
    'measureTarget is the number that means done, measureLabel names what is counted, measureUnit is its unit, and measureStart is where they are today. If the goal has no sensible number, set measureTarget to 0 and let the milestones carry it.',
    'milestones are three to six points on the way, in order, each dated between today and the target date, and each one something they can tell they have reached.',
    'A routine is small things done together at a set time, which is how the habit side of a goal actually happens: routineName, routineTime, routineWeekdays (0 is Sunday, 6 is Saturday), and routineHabits as two to five short labels. Leave routineName empty when the goal does not need one.',
    'steps are what repeats beyond the routine, at most four, each with freq "daily", "weekly" or "monthly". A weekly step needs a weekday (0 to 6) and a time.',
    'tasks are the first one to three things that get it moving, each due within the next fortnight, with minutes as a rough length.',
    'You are given a brief: their goal in their own words, every question they were asked and what they said, and the shape of the week this has to fit into. Use all of it. Where they did not answer, decide for them and move on.',
    'Respect the time they said they have. If they gave you hours a week, everything you plan together must fit inside it with room to spare. A plan they cannot keep is worse than no plan.',
    'Fit the plan around what is already in their week. Do not put a routine at an hour another routine already owns, and keep this goal modest when other goals are already running.',
    'Use what they told you about themselves. If something has stopped them before, the plan should answer it rather than ignore it.',
    'Be honest about pace. If their date cannot be reached safely or sensibly, set a target date that can be and say so plainly in note.',
    'Their categories are: ' + (categories || 'Personal, Work, Health') + '. Use exactly one of these names for category.',
    'Today is ' + today + '. Dates are "YYYY-MM-DD" and times are "HH:MM" on a 24 hour clock.',
    'Every field must be present. Where something does not apply, use an empty value: "" for text, 0 for numbers, [] for lists.',
    'note is one short sentence to them about the plan, or "" if you have nothing worth adding.'
  ].join(' ');

  const anythingSystem = [
    'You are Athena, the planner this person uses every day. They have typed one line into a box that does three different things, and your first job is to work out which.',
    'intent "add" when they are telling you about something new: appointments, things to do, a habit, a goal. Fill events, tasks, habits and goals exactly as you would for an import, leave changes empty, and put one short line in reply saying what you understood.',
    'intent "answer" when they are asking about their own week rather than changing it. Answer in reply, in at most three sentences, using their real blocks, tasks and times from the brief. Name actual things and actual times. Leave every list empty.',
    'intent "change" when they want something that already exists to be different. Put one entry in changes for each thing that has to move, and one short line in reply describing the lot in plain words.',
    'Never invent an id. Every id in changes must be copied exactly from the brief, and target must say which kind it is. If you cannot find the thing they mean, use intent "answer" and say which one you could not find.',
    'What each action needs: "move" a date; "retime" a start and an end, or just a start for a routine; "rename" a title; "recategorise" a category; "setdue" a date; "setminutes" minutes; "setpriority" a priority; "skip" the date to miss; "done" and "delete" need nothing more. Leave every other field empty.',
    'Moving a repeating block moves that one day only and leaves the repeat alone. Changing its time changes it from now on. If they asked for something you cannot express with those actions, use intent "answer" and say so plainly rather than doing something close to it.',
    'why is one short phrase saying what that single change does, in their words, for them to read before they agree to it.',
    'Be careful with delete. Prefer skipping one day, or marking something done, unless they clearly meant to get rid of the thing itself.',
    'Their categories are: ' + (categories || 'Personal, Work, Health') + '. Use exactly these names.',
    'Today is ' + today + '. Dates are "YYYY-MM-DD" and times are "HH:MM" on a 24 hour clock. Resolve "Friday" and "next week" against today.',
    'Every field must be present. Where something does not apply, use an empty value: "" for text, 0 for numbers, [] for lists.',
    'Warm, plain and short. Never a form, never a lecture.'
  ].join(' ');

  let system = listSystem, schema = planSchema(catNames), prompt = ask;
  if (mode === 'ask'){
    system = anythingSystem;
    schema = anythingSchema(catNames);
    prompt = week ? (week + '\n\nThey typed: ' + ask) : ask;
  } else if (mode === 'goalAsk'){
    system = askSystem;
    schema = askSchema();
    // A second round gets the brief, so it can ask what is still missing.
    prompt = brief || ask;
  } else if (mode === 'goalPlan'){
    system = goalPlanSystem;
    schema = goalSchema(catNames);
    prompt = brief || (ask + (answers ? '\n\nWhat they told me: ' + answers : ''));
  }

  try {
    const client = new Anthropic();   // reads ANTHROPIC_API_KEY
    const output_config = { format: zodOutputFormat(schema) };
    // effort is only accepted on some models, and Haiku is not one of them:
    // sending it there is a 400, not a polite ignore. Only add it when the
    // model in use actually supports it.
    if (EFFORT_OK.test(MODEL)) output_config.effort = 'low';
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system,
      output_config,
      messages: [{ role: 'user', content: prompt }]
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

/* Two "Claim Licence rebates" and two "Call Sue for Priya", each pair one
   timed and one not, both copies made on the same day. The cause was that
   the one thing Athena offers to do with overdue tasks, find them a slot,
   was the one thing it had no way to express: no action gave a task a time,
   so it added them again instead.

   These check both halves. The action now exists and is described, and the
   add path cannot put something on the list that is already on it. The
   second is the one that matters in a year, because it holds whatever any
   future model answers. */
const fs = require('fs');
const ai = fs.readFileSync('C:/Users/chane/Desktop/athena/api/ai.js', 'utf8');
const src = fs.readFileSync('C:/Users/chane/Desktop/athena/app.js', 'utf8');

let bad = 0;
const ok = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w){ bad++; console.log('FAIL ' + n + '\n  got  ' + g + '\n  want ' + w); }
};
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const A = code(ai), S = code(src);

// ---- the thing it could not say ----
ok('a task can be given a time', /'settime'/.test(A), true);
ok('and have one taken off', /'cleartime'/.test(A), true);
ok('the prompt says what settime needs', /"settime" a start/.test(A), true);
ok('and that placing is never a new task',
  /placing it, scheduling it, fitting it in: all of those are settime, and never a new task/.test(A), true);
ok('and says adding a second copy is always wrong',
  /adding a second copy of a task they already have is always wrong/.test(A), true);
ok('and the add rule says it from its own side',
  /Never add a task whose title matches one they already have/.test(A), true);

// ---- the browser understands and applies it ----
ok('prepChange builds a settime', /act === 'settime'/.test(S), true);
ok('and refuses one with no clock on it',
  /act === 'settime'\)\{[\s\S]{0,120}?if \(!okTime\(c\.start\)\) return null;/.test(S), true);
ok('askApply sets the time on the task that already exists',
  /c\.act === 'settime'\)\{[\s\S]{0,300}?tk\.at = normaliseAt/.test(S), true);
ok('through the same normaliser the editor uses', /tk\.at = normaliseAt\(c\.at, tk\)/.test(S), true);
ok('and cleartime puts it back to floating', /c\.act === 'cleartime'\)\{ tk\.at = null/.test(S), true);

// ---- and the guard that holds whatever is answered ----
ok('there is a check for a task already open', /function alreadyOpen\(title\)/.test(S), true);
ok('matched without case or surrounding space',
  /String\(s \|\| ''\)\.trim\(\)\.toLowerCase\(\)/.test(S), true);
ok('only against tasks that are not done', /!x\.doneAt && sameTitle\(x\.title\) === t/.test(S), true);
ok('the add path works out what is already there', /const skip = aiDupesToo \? \[\] : previewDupes\(\)/.test(S), true);
ok('and filters them out before pushing',
  /\.filter\(\(tk, i\) => skip\.indexOf\(i\) < 0\)/.test(S), true);
// The check has to happen where the add happens, not only where it is drawn:
// a task can be ticked off between the preview and the button.
const applyAt = S.indexOf('function aiApply');
const pushAt = S.indexOf('S.tasks.push.apply', applyAt);
const skipAt = S.indexOf('const skip =', applyAt);
ok('the check is inside aiApply', skipAt > applyAt && skipAt < pushAt, true);
ok('and runs before anything is pushed', skipAt < pushAt, true);
ok('she is told when something was held back', /were already on your list, so they were left alone/.test(S), true);
ok('and can add it anyway on purpose', /data-aidupes/.test(S), true);
ok('which is off again next time', /aiDupesToo = false;/.test(S), true);

console.log(bad ? '\n' + bad + ' failed' : '\n21 duplicate tests pass');
process.exit(bad ? 1 : 0);

/* Every suite, in one go. Exits non-zero if any of them do, so this is the
   one command worth running before a push. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs')).sort();
if (!files.length){ console.log('No suites found in ' + dir); process.exit(1); }

let failed = 0;
files.forEach(f => {
  process.stdout.write(f.replace(/\.test.cjs$/, '').padEnd(16, ' '));
  try {
    const out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
    console.log(out.trim().split('\n').pop());
  } catch (e){
    failed++;
    console.log('FAILED');
    console.log((e.stdout || '') + (e.stderr || ''));
  }
});
console.log(failed ? '\n' + failed + ' suite' + (failed !== 1 ? 's' : '') + ' failed'
                   : '\nall ' + files.length + ' suites pass');
process.exit(failed ? 1 : 0);

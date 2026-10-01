// Bare node-pty echo latency repro: measures pty.write -> onData lag with and
// without a second session flooding output. Run: node scripts/repro-pty-echo.cjs [flood]
const pty = require('node-pty');

const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
const opts = {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, ANTIFAN_SESSION_ID: 'repro' },
  useConpty: process.env.ANTIFAN_USE_CONPTY === '1',
};

const flood = process.argv.includes('flood');
const p1 = pty.spawn(shell, [], { ...opts, env: { ...opts.env, ANTIFAN_SESSION_ID: 'repro-a' } });
let p2 = null;
if (flood) {
  p2 = pty.spawn(shell, [], { ...opts, env: { ...opts.env, ANTIFAN_SESSION_ID: 'repro-b' } });
  p2.onData(() => {});
  setTimeout(() => {
    p2.write('node -e "setInterval(()=>process.stdout.write(String(1).repeat(999)+\'\\n\'),1)"\r');
  }, 1500);
}

let n = 0;
const sent = new Map();
let chunks = 0;
p1.onData((d) => {
  chunks++;
  for (const m of String(d).matchAll(/MARKX(\d+)/g)) {
    if (sent.has(m[1])) {
      console.log(`t=${performance.now().toFixed(0)} mark=${m[1]} lag=${(performance.now() - sent.get(m[1])).toFixed(0)}ms`);
      sent.delete(m[1]);
    }
  }
});

setTimeout(() => p1.write('prompt $g\r'), 1200);
const iv = setInterval(() => {
  n++;
  sent.set(String(n), performance.now());
  p1.write(`echo MARKX${n}\r`);
}, 300);

setTimeout(() => {
  clearInterval(iv);
  console.log(`done chunks=${chunks}`);
  p1.kill();
  if (p2) p2.kill();
  process.exit(0);
}, 20000);

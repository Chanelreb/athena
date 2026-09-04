// Minimal static file server for local development — no dependencies.
//   node serve.js            → serves this folder at http://127.0.0.1:8000
//   node serve.js 3000       → serves on port 3000
// Athena is a no-build static app; this just serves the files over HTTP so the
// browser will load styles.css and app.js (some browsers block those over file://).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // Resolve inside ROOT and refuse anything that escapes it.
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Athena serving at http://127.0.0.1:' + PORT);
});

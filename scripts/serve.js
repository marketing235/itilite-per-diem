// Local test server: serves the repo root on http://localhost:8080 using only node:http.
// HTML files get a server-side include swap, so a harness page holds the real calculator markup
// before its <script> tag, the way the Webflow page does:
//   <!--#include file="fixtures/03-calculator.html" -->                  path relative to the page
//   <!--#include file="fixtures/03-calculator.html" data-state="CA" -->  also sets data-state on
//                                                                        the [data-perdiem-calc] root
// A missing include or a failed swap is a 500 with the reason, never a silently broken page.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOST = '127.0.0.1';
const PORT = 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
const INCLUDE = /<!--#include\s+file="([^"]+)"((?:\s+[\w-]+="[^"]*")*)\s*-->/g;

// Resolves a path and refuses anything outside the repo root.
function inRoot(path) {
  const full = resolve(path);
  if (full !== ROOT.slice(0, -1) && !full.startsWith(ROOT)) throw Object.assign(new Error('outside repo root'), { status: 403 });
  return full;
}

async function expandIncludes(html, fromFile, depth) {
  if (depth > 3) throw new Error('includes nested more than 3 deep in ' + fromFile);
  const parts = [];
  let last = 0;
  for (const m of html.matchAll(INCLUDE)) {
    const file = inRoot(resolve(dirname(fromFile), m[1]));
    let body;
    try {
      body = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error('include not found: ' + m[1] + ' (from ' + fromFile + ')');
    }
    body = await expandIncludes(body, file, depth + 1);
    for (const [, name, value] of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (name !== 'data-state') throw new Error('unsupported include attribute ' + name + ' in ' + fromFile);
      const root = /(<[^>]*\bdata-perdiem-calc\b[^>]*\bdata-state=")[^"]*(")/;
      if (!root.test(body)) throw new Error('no [data-perdiem-calc][data-state] element in ' + m[1]);
      body = body.replace(root, '$1' + value + '$2');
    }
    parts.push(html.slice(last, m.index), body);
    last = m.index + m[0].length;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw Object.assign(new Error('method not allowed'), { status: 405 });
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/test/harness.html' });
      return res.end();
    }
    const file = inRoot(resolve(ROOT, '.' + decodeURIComponent(url.pathname).split('/').join(sep)));
    let body;
    try {
      body = await readFile(file);
    } catch (err) {
      throw Object.assign(new Error('not found: ' + url.pathname), { status: 404 });
    }
    const ext = extname(file).toLowerCase();
    if (ext === '.html') body = await expandIncludes(body.toString('utf8'), file, 0);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    console.log(200, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    console.error(status, url.pathname, '—', err.message);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(status + ' ' + err.message + '\n');
  }
});

server.on('error', (err) => {
  console.error('serve: ' + err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log('Serving ' + ROOT + ' on http://localhost:' + PORT);
  console.log('  http://localhost:' + PORT + '/test/harness.html        main page (no state)');
  console.log('  http://localhost:' + PORT + '/test/harness-state.html  state page (data-state="CA")');
});

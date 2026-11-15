'use strict';
// Node.js 22+, standard library only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const ACTIONS = new Set(['status', 'interfaces', 'wireless', 'sms.list', 'sms.read', 'sms.send', 'interface.restart', 'wireless.up', 'wireless.down']);

async function createManager(options = {}) {
 const password = options.password ?? process.env.MANAGEMENT_PASSWORD;
 if (typeof password !== 'string' || password.length < 12) throw new Error('Set MANAGEMENT_PASSWORD to at least 12 characters.');
 const origin = new URL(options.origin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000').origin;
 const secure = origin.startsWith('https:');
 const dataDir = options.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, '.data');
 fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
 const stateFile = path.join(dataDir, 'routers.json');
 let routers = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
 const salt = crypto.randomBytes(16), passwordKey = await scrypt(password, salt, 32);
 const sessions = new Map(), live = new Map(), jobs = new Map(), failures = new Map();
 const pollMs = options.pollMs ?? 20000, commandMs = options.commandMs ?? 55000;
 function save() { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(routers), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); }
 function json(res, status, data) { if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } }
 function fail(status, message) { throw Object.assign(new Error(message), { status }); }
 async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 262144) fail(413, 'Request too large'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { fail(400, 'Invalid JSON object'); }
 }
 function state(id) { if (!live.has(id)) live.set(id, { lastSeen: 0, poll: null, job: null }); return live.get(id); }
 function finish(job, status, data) { clearTimeout(job.timer); jobs.delete(job.id); const s = state(job.router); if (s.job === job) s.job = null; json(job.response, status, { requestId: job.id, ...data }); }
 function deliver(s) { if (!s.poll || !s.job || s.job.delivered) return; const poll = s.poll; s.poll = null; clearTimeout(poll.timer); s.job.delivered = true; json(poll.response, 200, { id: s.job.id, action: s.job.action, args: s.job.args }); }
 function validate(action, args) {
  if (!ACTIONS.has(action)) fail(400, 'Unsupported action');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'Invalid arguments');
  if (action === 'sms.read' && !/^[0-9]{1,10}$/.test(args.id || '')) fail(400, 'Invalid SMS ID');
  if (action === 'sms.send' && (typeof args.number !== 'string' || !/^\+?[0-9]{1,20}$/.test(args.number) || typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 4096)) fail(400, 'Invalid SMS recipient or text');
  if ((action === 'interface.restart' || action.startsWith('wireless.') && action !== 'wireless') && (typeof args.name !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(args.name))) fail(400, 'Invalid interface or radio name');
 }
 const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
   const url = new URL(req.url, origin), route = url.pathname, method = req.method;
   if (method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
    res.setHeader('Content-Type', route === '/' ? 'text/html; charset=utf-8' : route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    return res.end(fs.readFileSync(path.join(__dirname, 'public', route === '/' ? 'index.html' : route.slice(1))));
   }
   if (route.startsWith('/api/agent/')) {
    if (method !== 'POST') fail(405, 'POST required');
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const router = token.length === 64 && routers.find(r => r.tokenHash === hash(token));
    if (!router) fail(401, 'Invalid router token');
    const s = state(router.id); s.lastSeen = Date.now();
    if (route === '/api/agent/poll') {
     await body(req);
     if (s.poll) fail(409, 'A router connection is already polling');
     const poll = { response: res }; s.poll = poll;
     poll.timer = setTimeout(() => { if (s.poll === poll) s.poll = null; json(res, 200, { idle: true }); }, pollMs);
     res.on('close', () => { clearTimeout(poll.timer); if (s.poll === poll) s.poll = null; });
     return deliver(s);
    }
    if (route === '/api/agent/result') {
     const value = await body(req), job = jobs.get(value.id);
     if (!job || job.router !== router.id || !job.delivered) fail(409, 'Request expired or unknown; it will not be retried');
     finish(job, 200, { result: value.result }); return json(res, 200, { ok: true });
    }
    fail(404, 'Unknown agent endpoint');
   }
   if (method !== 'GET' && req.headers.origin !== origin) fail(403, 'Origin check failed');
   if (route === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress, now = Date.now();
    for (const [key, value] of failures) if (now - value.start > 900000) failures.delete(key);
    const attempt = failures.get(ip) || { count: 0, start: now };
    if (attempt.count >= 10 || failures.size >= 1000) fail(429, 'Too many login attempts. Try again in 15 minutes.');
    attempt.count++; failures.set(ip, attempt);
    const input = await body(req);
    const supplied = await scrypt(typeof input.password === 'string' ? input.password.slice(0, 1024) : '', salt, 32);
    if (!crypto.timingSafeEqual(supplied, passwordKey)) fail(401, 'Incorrect password');
    failures.delete(ip);
    for (const [key, value] of sessions) if (value < now) sessions.delete(key);
    if (sessions.size >= 1000) fail(429, 'Too many active sessions');
    const sid = random(); sessions.set(hash(sid), now + 8 * 3600000);
    res.setHeader('Set-Cookie', `mifi_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
   }
   const cookie = /(?:^|;\s*)mifi_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
   const sidHash = cookie && hash(cookie[1]);
   if (!sidHash || !(sessions.get(sidHash) > Date.now())) fail(401, 'Sign in required');
   if (route === '/api/logout' && method === 'POST') { sessions.delete(sidHash); res.setHeader('Set-Cookie', `mifi_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`); return json(res, 200, { ok: true }); }
   if (route === '/api/routers' && method === 'GET') return json(res, 200, routers.map(r => ({ id: r.id, name: r.name, lastSeen: state(r.id).lastSeen, online: Date.now() - state(r.id).lastSeen < 45000, busy: !!state(r.id).job })));
   if (route === '/api/routers' && method === 'POST') {
    const value = await body(req); if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) fail(400, 'Enter a router name (up to 80 characters)');
    if (routers.length >= 100) fail(400, 'Router limit reached');
    const token = random(), router = { id: crypto.randomUUID(), name: value.name.trim(), tokenHash: hash(token) };
    routers.push(router); save(); return json(res, 201, { id: router.id, name: router.name, token });
   }
   const match = /^\/api\/routers\/([a-f0-9-]{36})(?:\/(commands|rotate))?$/.exec(route);
   if (match) {
    const router = routers.find(r => r.id === match[1]); if (!router) fail(404, 'Router not found');
    const s = state(router.id);
    if (method === 'DELETE' && !match[2] || method === 'POST' && match[2] === 'rotate') {
     if (s.poll) { clearTimeout(s.poll.timer); json(s.poll.response, 401, { error: 'Token revoked' }); s.poll = null; }
     if (s.job) finish(s.job, 409, { error: 'Router token revoked. Check the router before repeating any action.' });
     s.lastSeen = 0;
     if (method === 'DELETE') { routers = routers.filter(r => r !== router); save(); return json(res, 200, { ok: true }); }
     const token = random(); router.tokenHash = hash(token); save(); return json(res, 200, { token });
    }
    if (method === 'POST' && match[2] === 'commands') {
     const value = await body(req); validate(value.action, value.args ?? {});
     if (Date.now() - s.lastSeen > 45000) fail(409, 'Router is offline');
     if (s.job) fail(409, 'Router is busy. Wait for the current request.');
     const job = { id: crypto.randomUUID(), router: router.id, action: value.action, args: value.args ?? {}, response: res, delivered: false };
     job.timer = setTimeout(() => finish(job, 504, { error: 'Router request timed out. It will not be retried. Check its state before repeating a change.' }), commandMs);
     jobs.set(job.id, job); s.job = job; return deliver(s);
    }
   }
   fail(404, 'Not found');
  } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' }); }
 });
 server.headersTimeout = 15000; server.requestTimeout = 65000;
 server.on('close', () => { for (const job of jobs.values()) clearTimeout(job.timer); for (const s of live.values()) if (s.poll) clearTimeout(s.poll.timer); });
 return server;
}
if (require.main === module) createManager().then(server => server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('MiFi manager listening'))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createManager };

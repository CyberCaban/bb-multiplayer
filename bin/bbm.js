#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createHub, hashToken, save } from '../src/hub.js';

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const envFile = envIndex >= 0 ? args.splice(envIndex, 2)[1] : '.env';
if (!envFile) throw new Error('--env requires a path');
if (envIndex >= 0 && !existsSync(envFile)) { console.error(`Environment file not found: ${envFile}`); process.exit(1); }
if (existsSync(envFile)) for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) if (process.env[key] === undefined) process.env[key] = value;
const [command, ...rest] = args;
const env = process.env;
const dir = resolve(env.BBM_DATA_DIR || '.bbm');
const print = data => console.log(JSON.stringify(data, null, 2));
const required = (value, label) => { if (!value) throw new Error(`Required: ${label}`); return value; };

async function main() {
  if (command === 'hub-init') {
    const [room, a, b] = rest;
    if (![room, a, b].every(v => /^[a-zA-Z0-9_-]{1,64}$/.test(v ?? '') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v)) || a === b) throw new Error('Usage: bbm hub-init <room> <member-a> <member-b> (letters, digits, _ or -; no reserved Windows filenames)');
    if (existsSync(dir)) throw new Error(`${dir} already exists; initialization refuses to overwrite credentials`);
    mkdirSync(dir, { recursive: true });
    const members = [a, b].map(name => ({ name, token: randomBytes(32).toString('hex') }));
    save(resolve(dir, 'hub.json'), { room, members: members.map(m => ({ name: m.name, tokenHash: hashToken(m.token) })) });
    for (const m of members) writeFileSync(resolve(dir, `${m.name}.env`), `BBM_HUB_URL=http://127.0.0.1:8787\nBBM_ROOM=${room}\nBBM_NAME=${m.name}\nBBM_TOKEN=${m.token}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Created ${dir}/hub.json and personal ${a}.env / ${b}.env. Deliver each personal file privately; change BBM_HUB_URL for the shared HTTPS Hub.`);
    return;
  }
  if (command === 'hub') {
    const config = JSON.parse(readFileSync(resolve(dir, 'hub.json'), 'utf8'));
    const server = createHub({ config, storePath: resolve(dir, 'store.json') });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(Number(env.BBM_PORT || 8787), env.BBM_HOST || '127.0.0.1', () => console.log(`Hub listening on ${env.BBM_HOST || '127.0.0.1'}:${server.address().port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
    return;
  }
  if (!command || command === 'help' || command === '--help') {
    console.log('bbm [--env path] <command>\n hub-init <room> <member-a> <member-b>\n hub\n status [--watch]\n context\n set-context <name> <goal> <architecture>\n tasks\n create-task <title> <description> [assignee]\n assign-task <id> <member>\n claim-task <id>\n complete-task <id>\n send-message <text> [recipient]\n messages [after-message-id]\nAll client output is JSON. Quote arguments containing spaces.');
    return;
  }
  const routes = {
    status: ['GET', '/status'], context: ['GET', '/context'], tasks: ['GET', '/tasks'],
    messages: ['GET', '/messages' + (rest[0] ? `?after=${encodeURIComponent(rest[0])}` : '')],
  };
  // Construct mutating commands lazily so unrelated commands require no arguments.
  let route = Object.hasOwn(routes, command) ? routes[command] : undefined;
  if (command === 'set-context') route = ['POST', '/context', { name: required(rest[0], 'name'), goal: required(rest[1], 'goal'), architecture: required(rest[2], 'architecture') }];
  if (command === 'create-task') route = ['POST', '/tasks', { title: required(rest[0], 'title'), description: required(rest[1], 'description'), assignedTo: rest[2] ?? null }];
  if (['claim-task', 'complete-task', 'assign-task'].includes(command)) route = ['POST', `/tasks/${encodeURIComponent(required(rest[0], 'task id'))}/${command.split('-')[0]}`, command === 'assign-task' ? { assignedTo: required(rest[1], 'member') } : {}];
  if (command === 'send-message') route = ['POST', '/messages', { text: required(rest[0], 'message'), to: rest[1] ?? null }];
  if (!route) throw new Error('Unknown command; run bbm help');
  const base = new URL(required(env.BBM_HUB_URL, 'BBM_HUB_URL'));
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || env.BBM_ALLOW_HTTP === 'true'))) throw new Error('Use HTTPS for a remote Hub or explicitly set BBM_ALLOW_HTTP=true for a trusted network');
  const token = required(env.BBM_TOKEN, 'BBM_TOKEN');
  const room = required(env.BBM_ROOM, 'BBM_ROOM');
  const name = required(env.BBM_NAME, 'BBM_NAME');
  async function request() {
    const response = await fetch(new URL(`/rooms/${encodeURIComponent(room)}${route[1]}`, base), { method: route[0], headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-BBM-Name': name }, body: route[2] ? JSON.stringify(route[2]) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
    if (command === 'status' && data.you !== name) throw new Error('BBM_NAME does not match the personal token');
    print(data);
  }
  await request();
  if (command === 'status' && rest.includes('--watch')) for (;;) { await new Promise(r => setTimeout(r, 3000)); await request(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const string = (value, field, max = 10000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `Invalid ${field} (1-${max} characters)`);
  return value.trim();
};
export function save(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

// One Hub process owns one store. All read/modify/write transactions are synchronous.
export function createHub({ config, storePath }) {
  if (!config.room || config.members?.length !== 2 || new Set(config.members.map(m => m.name)).size !== 2 || config.members.some(m => !/^[a-f0-9]{64}$/.test(m.tokenHash)) || config.members[0].tokenHash === config.members[1].tokenHash) throw new Error('Invalid Hub configuration');
  let state;
  try { state = JSON.parse(readFileSync(storePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { room: config.room, context: { name: config.room, goal: '', architecture: '' }, tasks: [], messages: [] }; }
  if (state.room !== config.room) throw new Error('Store belongs to a different room');
  if (!state.context || typeof state.context !== 'object' || !Array.isArray(state.tasks) || !Array.isArray(state.messages)) throw new Error('Invalid Hub store');
  const seen = new Map();
  const members = () => config.members.map(m => ({ name: m.name, lastSeen: seen.get(m.name) ?? null, online: Date.now() - (seen.get(m.name) ?? 0) < 60000 }));
  const commit = (next) => { save(storePath, next); state = next; };
  const server = http.createServer(async (req, res) => {
    const respond = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const auth = req.headers.authorization ?? '';
      const member = auth.startsWith('Bearer ') && config.members.find(m => m.tokenHash === hashToken(auth.slice(7)));
      if (!member) fail(401, 'Invalid personal token');
      if (req.headers['x-bbm-name'] !== undefined && req.headers['x-bbm-name'] !== member.name) fail(403, 'BBM_NAME does not match the personal token');
      const url = new URL(req.url, 'http://hub');
      const prefix = `/rooms/${encodeURIComponent(config.room)}`;
      if (!url.pathname.startsWith(prefix + '/')) fail(404, 'Room not found');
      seen.set(member.name, Date.now());
      const route = url.pathname.slice(prefix.length);
      const method = req.method;
      let body = {};
      if (method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 65536) { req.resume(); fail(413, 'Request too large'); }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'Invalid JSON'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'Expected JSON object');
      }
      let result;
      if (method === 'GET' && route === '/status') result = { room: config.room, you: member.name, members: members() };
      else if (method === 'GET' && route === '/context') result = { ...state.context, members: members(), tasks: state.tasks, messages: state.messages.slice(-50) };
      else if (method === 'GET' && route === '/tasks') result = state.tasks;
      else if (method === 'GET' && route === '/messages') {
        const after = url.searchParams.get('after');
        const index = after ? state.messages.findIndex(m => m.id === after) : -1;
        if (after && index < 0) fail(400, 'Unknown message cursor');
        result = state.messages.slice(index + 1).filter(m => !m.to || m.to === member.name || m.from === member.name);
      } else if (method === 'POST') {
        const next = structuredClone(state);
        if (route === '/context') {
          for (const key of ['name', 'goal', 'architecture']) if (body[key] !== undefined) {
            if (typeof body[key] !== 'string' || body[key].length > 10000) fail(400, `Invalid ${key}`);
            next.context[key] = body[key];
          }
          result = next.context;
        } else if (route === '/tasks') {
          const assignedTo = body.assignedTo ?? null;
          if (assignedTo !== null && !config.members.some(m => m.name === assignedTo)) fail(400, 'Unknown assignee');
          result = { id: randomUUID(), title: string(body.title, 'title', 200), description: body.description === undefined ? '' : string(body.description, 'description'), assignedTo, status: 'todo' };
          next.tasks.push(result);
        } else if (/^\/tasks\/[^/]+\/(claim|complete|assign)$/.test(route)) {
          const [, , id, action] = route.split('/');
          const task = next.tasks.find(t => t.id === id);
          if (!task) fail(404, 'Task not found');
          if (action === 'assign') {
            if (task.status !== 'todo') fail(409, 'Only todo tasks can be assigned');
            if (!config.members.some(m => m.name === body.assignedTo)) fail(400, 'Unknown assignee');
            task.assignedTo = body.assignedTo;
          } else {
            if (task.assignedTo && task.assignedTo !== member.name) fail(409, 'Task belongs to another member');
            if (action === 'claim') { if (task.status === 'done') fail(409, 'Task is already done'); task.assignedTo = member.name; task.status = 'doing'; }
            else { if (task.status !== 'doing') fail(409, 'Claim the task before completing it'); task.status = 'done'; }
          }
          result = task;
        } else if (route === '/messages') {
          const to = body.to ?? null;
          if (to !== null && !config.members.some(m => m.name === to)) fail(400, 'Unknown recipient');
          result = { id: randomUUID(), from: member.name, to, text: string(body.text, 'text'), createdAt: new Date().toISOString() };
          next.messages.push(result);
        } else fail(404, 'Route not found');
        commit(next);
      } else fail(404, 'Route not found');
      respond(200, result);
    } catch (error) { respond(error.status ?? 500, { error: error.status ? error.message : 'Hub storage or internal error' }); }
  });
  server.requestTimeout = 15000;
  return server;
}

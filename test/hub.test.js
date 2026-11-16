import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createHub, hashToken } from '../src/hub.js';

test('two clients: authorization, assignment races, messages and restart persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbm-test-'));
  const config = { room: 'demo', members: [{ name: 'alice', tokenHash: hashToken('alice-secret') }, { name: 'bob', tokenHash: hashToken('bob-secret') }] };
  let server;
  let base;
  async function start() {
    server = createHub({ config, storePath: join(dir, 'store.json') });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { server.close(); await once(server, 'close'); }
  async function call(who, path, body, expected = 200, room = 'demo') {
    const res = await fetch(`${base}/rooms/${room}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${who}-secret` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, expected, JSON.stringify(data)); return data;
  }
  try {
    await start();
    await call('unknown', '/status', undefined, 401);
    await call('alice', '/status', undefined, 404, 'other');
    await call('alice', '/status');
    assert.equal((await call('bob', '/status')).members.filter(m => m.online).length, 2);
    await call('alice', '/context', { goal: 'Ship together', architecture: 'Node HTTP' });
    const bytes = Buffer.from(JSON.stringify({ text: 'Привет, напарник 👋' }));
    const split = bytes.indexOf(Buffer.from('П')) + 1;
    const received = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/rooms/demo/messages`, { method: 'POST', headers: { Authorization: 'Bearer alice-secret' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.write(bytes.subarray(0, split)); setTimeout(() => req.end(bytes.subarray(split)), 20);
    });
    assert.equal(received.text, 'Привет, напарник 👋');
    const assigned = await call('alice', '/tasks', { title: 'Frontend', description: 'Use /api/users', assignedTo: 'bob' });
    await call('alice', `/tasks/${assigned.id}/claim`, {}, 409);
    await call('bob', `/tasks/${assigned.id}/claim`, {});
    await call('alice', `/tasks/${assigned.id}/assign`, { assignedTo: 'alice' }, 409);
    await call('bob', `/tasks/${assigned.id}/complete`, {});
    const message = await call('bob', '/messages', { to: 'alice', text: 'PR: https://example.com/pull/1' });
    assert.equal((await call('alice', '/messages')).at(-1).text, message.text);
    assert.deepEqual(await call('alice', `/messages?after=${message.id}`), []);
    const open = await call('alice', '/tasks', { title: 'Race' });
    const results = await Promise.all(['alice', 'bob'].map(async who => {
      const res = await fetch(`${base}/rooms/demo/tasks/${open.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${who}-secret` }, body: '{}' }); return res.status;
    }));
    assert.deepEqual(results.sort(), [200, 409]);
    await call('alice', '/tasks', { title: '' }, 400);
    await call('alice', '/messages', { text: 'x'.repeat(66000) }, 413);
    await stop(); await start();
    assert.equal((await call('alice', '/tasks'))[0].status, 'done');
    assert.equal((await call('alice', '/messages')).at(-1).id, message.id);
    assert.equal((await call('bob', '/context')).goal, 'Ship together');
  } finally { if (server?.listening) await stop(); rmSync(dir, { recursive: true, force: true }); }
});

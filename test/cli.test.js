import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const exec = promisify(execFile);
test('real Hub process and two independent CLI clients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbm-cli-'));
  const bin = resolve('bin/bbm.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BBM_')));
  Object.assign(env, { BBM_DATA_DIR: join(dir, '.bbm'), BBM_PORT: '0' });
  const run = async (...args) => (await exec(process.execPath, [bin, ...args], { cwd: dir, env })).stdout;
  let child;
  async function start() {
    child = spawn(process.execPath, [bin, 'hub'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = await new Promise((resolve, reject) => { child.stdout.once('data', data => resolve(data.toString())); child.once('error', reject); child.once('exit', code => reject(new Error(`Hub exited: ${code}`))); });
    const port = line.match(/:(\d+)/)[1];
    for (const name of ['alice', 'bob']) {
      const source = readFileSync(join(dir, '.bbm', `${name}.env`), 'utf8');
      writeFileSync(join(dir, `${name}.env`), source.replace('8787', port));
    }
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; }
  const client = async (name, ...args) => JSON.parse(await run('--env', join(dir, `${name}.env`), ...args));
  try {
    await run('hub-init', 'demo', 'alice', 'bob'); await start();
    assert.equal((await client('alice', 'status')).you, 'alice');
    assert.equal((await client('bob', 'status')).members.filter(m => m.online).length, 2);
    await client('alice', 'set-context', 'Demo', 'Build API and frontend', 'Separate Git clones');
    const task = await client('alice', 'create-task', 'Frontend', 'Consume /api/users', 'bob');
    assert.equal((await client('bob', 'tasks'))[0].id, task.id);
    await client('bob', 'claim-task', task.id);
    await client('bob', 'complete-task', task.id);
    await client('bob', 'send-message', 'Result: https://example.com/pull/1', 'alice');
    assert.match((await client('alice', 'messages'))[0].text, /pull\/1/);
    await client('alice', 'send-message', 'Received; reviewing the API integration', 'bob');
    assert.equal((await client('bob', 'messages')).length, 2);
    await stop(); await start();
    assert.equal((await client('alice', 'tasks'))[0].status, 'done');
    assert.equal((await client('bob', 'messages')).length, 2);
    console.log('CLI demo: Alice assigned → Bob claimed/completed → PR link → Alice replied → Hub restart preserved task and messages');
  } finally { if (child && child.exitCode === null) await stop(); rmSync(dir, { recursive: true, force: true }); }
});

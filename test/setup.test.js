import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
const exec = promisify(execFile);

test('remote HTTP requires opt-in and user installation preserves it', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'bbm-http-'));
  const setup = (...args) => exec(process.execPath, [resolve('scripts/setup.js'), ...args]);
  const hub = join(root, 'hub');
  const args = ['hub', '--dir', hub, '--room', 'demo', '--members', 'alice,bob', '--url', 'http://192.0.2.1:8787'];
  try {
    await assert.rejects(setup(...args), /explicit --allow-http/);
    assert.equal(existsSync(hub), false);
    await setup(...args, '--allow-http');
    assert.match(readFileSync(join(hub, 'hub.env'), 'utf8'), /BBM_HOST=0.0.0.0/);
    const personal = join(hub, '.bbm/alice.env');
    assert.match(readFileSync(personal, 'utf8'), /BBM_ALLOW_HTTP=true/);
    const target = join(root, 'user');
    await setup('user', '--dir', target, '--env', personal, '--skills-dir', join(root, 'skills'));
    assert.match(readFileSync(join(target, 'personal.env'), 'utf8'), /BBM_ALLOW_HTTP=true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('install Hub and two user copies with skills, refuse overwrite, run from unrelated cwd', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'bbm-install-'));
  const hub = join(root, 'hub copy');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BBM_')));
  const setup = (...args) => exec(process.execPath, [resolve('scripts/setup.js'), ...args], { env });
  let child;
  try {
    await setup('hub', '--dir', hub, '--room', 'demo', '--members', 'alice,bob');
    const hubEnv = join(hub, 'hub.env');
    writeFileSync(hubEnv, readFileSync(hubEnv, 'utf8').replace('BBM_PORT=8787', 'BBM_PORT=0'));
    child = spawn(process.execPath, [join(hub, 'bin/bbm.js'), '--env', hubEnv, 'hub'], { cwd: root, env });
    const line = await new Promise((resolve, reject) => { child.stdout.once('data', d => resolve(d.toString())); child.once('error', reject); child.once('exit', code => reject(new Error(`Hub exited ${code}`))); });
    const port = line.match(/:(\d+)/)[1];
    for (const name of ['alice', 'bob']) {
      const credentials = join(hub, '.bbm', `${name}.env`);
      writeFileSync(credentials, readFileSync(credentials, 'utf8').replace('8787', port));
      const target = join(root, `${name} copy`);
      const skills = join(root, `${name} skills`);
      await setup('user', '--dir', target, '--env', credentials, '--skills-dir', skills);
      const skill = readFileSync(join(skills, 'bb-multiplayer/SKILL.md'), 'utf8');
      assert.ok(skill.includes(target));
      const result = await exec(process.execPath, [join(target, 'bin/bbm.js'), '--env', join(target, 'personal.env'), 'status'], { cwd: root, env });
      assert.equal(JSON.parse(result.stdout).you, name);
      assert.ok(existsSync(join(target, 'bbm.cmd')));
      assert.ok(existsSync(join(target, 'bbm')));
      const launcher = process.platform === 'win32'
        ? await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(target, 'bbm.ps1'), 'status'], { cwd: root, env })
        : await exec(join(target, 'bbm'), ['status'], { cwd: root, env });
      assert.ok(launcher.stdout.trim(), JSON.stringify(launcher));
      assert.equal(JSON.parse(launcher.stdout).you, name);
      if (process.platform === 'win32') {
        const cmd = await exec('powershell.exe', ['-NoProfile', '-Command', `& '${join(target, 'bbm.cmd').replaceAll("'", "''")}' status; exit $LASTEXITCODE`], { cwd: root, env });
        assert.equal(JSON.parse(cmd.stdout).you, name);
      }
      await assert.rejects(setup('user', '--dir', target, '--env', credentials, '--skills-dir', skills), /already exists/);
      const mismatch = join(root, `${name}-wrong.env`);
      writeFileSync(mismatch, readFileSync(credentials, 'utf8').replace(`BBM_NAME=${name}`, 'BBM_NAME=wrong'));
      await assert.rejects(exec(process.execPath, [join(target, 'bin/bbm.js'), '--env', mismatch, 'send-message', 'should not appear'], { cwd: root, env }), /403/);
    }
    await assert.rejects(setup('hub', '--dir', hub, '--room', 'demo', '--members', 'alice,bob'), /already exists/);
    await assert.rejects(exec(process.execPath, [join(hub, 'bin/bbm.js'), '--env', join(root, 'missing.env'), 'status'], { env }), /Environment file not found/);
  } finally {
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    rmSync(root, { recursive: true, force: true });
  }
});

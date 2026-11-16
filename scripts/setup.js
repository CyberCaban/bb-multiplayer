#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [kind, ...args] = process.argv.slice(2);
const options = {};
const usage = 'npm run setup:hub -- --dir <new-folder> --room <room> --members alice,bob --url https://hub.example.com [--allow-http]\nnpm run setup:user -- --dir <new-folder> --env <personal.env> [--skills-dir <BB-skills-folder>] [--allow-http]';
const quoteSh = value => `'${value.replaceAll("'", "'\\''")}'`;
const quotePs = value => `'${value.replaceAll("'", "''")}'`;
function write(file, content, mode = 0o600) { writeFileSync(file, content, { flag: 'wx', mode }); }
function launchers(target, name, command) {
  // Launch relative to the installed copy, independent of the caller's working directory.
  write(join(target, `${name}.cmd`), `@echo off\r\nnode "%~dp0bin\\bbm.js" ${command.cmd} %*\r\n`, 0o700);
  write(join(target, `${name}.ps1`), `$ErrorActionPreference = 'Stop'\n& node (Join-Path $PSScriptRoot 'bin/bbm.js') ${command.ps} @args\nexit $LASTEXITCODE\n`, 0o700);
  write(join(target, name), `#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexec node "$SCRIPT_DIR/bin/bbm.js" ${command.sh} "$@"\n`, 0o700);
}
try {
  if (args.includes('--help') || !kind) { console.log(usage); process.exit(0); }
  if (!['hub', 'user'].includes(kind)) throw new Error(usage);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (key === '--allow-http') { if (options[key]) throw new Error('Duplicate --allow-http'); options[key] = true; i--; continue; }
    if (!['--dir', '--room', '--members', '--url', '--env', '--skills-dir'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`Invalid option: ${key}\n${usage}`);
    options[key] = value;
  }
  if (!options['--dir']) throw new Error('--dir is required');
  const target = resolve(options['--dir']);
  const insideSource = relative(source, target);
  if (!insideSource || (!insideSource.startsWith('..') && !isAbsolute(insideSource))) throw new Error('Install outside the source directory');
  if (existsSync(target)) throw new Error('Installation directory already exists; nothing overwritten');
  let personal;
  let url;
  let names;
  let skillTarget;
  let allowHttp = options['--allow-http'] === true;
  if (kind === 'hub') {
    names = options['--members']?.split(',');
    if (!options['--room'] || names?.length !== 2) throw new Error('--room and --members alice,bob are required');
    url = new URL(options['--url'] || 'http://127.0.0.1:8787');
  } else {
    if (!options['--env']) throw new Error('--env is required');
    personal = readFileSync(resolve(options['--env']), 'utf8');
    const config = parseEnv(personal);
    allowHttp ||= config.BBM_ALLOW_HTTP === 'true';
    for (const key of ['BBM_HUB_URL', 'BBM_ROOM', 'BBM_NAME', 'BBM_TOKEN']) if (!config[key]) throw new Error(`Missing ${key} in personal env file`);
    // Copy only client settings, never server options from an arbitrary env file.
    personal = ['BBM_HUB_URL', 'BBM_ROOM', 'BBM_NAME', 'BBM_TOKEN'].map(k => `${k}=${JSON.stringify(config[k])}\n`).join('');
    if (allowHttp) personal += 'BBM_ALLOW_HTTP=true\n';
    url = new URL(config.BBM_HUB_URL);
    skillTarget = join(resolve(options['--skills-dir'] || join(homedir(), '.bb', 'skills')), 'bb-multiplayer');
    if (existsSync(skillTarget)) throw new Error(`Skill already exists: ${skillTarget}; nothing overwritten`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Hub URL must be an origin without credentials, path, query or fragment');
  const remoteHttp = url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (!remoteHttp || allowHttp))) throw new Error('Remote Hub requires HTTPS or explicit --allow-http');
  if (remoteHttp) console.error('Warning: HTTP sends tokens and messages without encryption. Use a trusted network or VPN.');
  mkdirSync(target, { recursive: true });
  let createdSkill = false;
  try {
    for (const path of ['bin', 'src', 'skills', 'scripts', 'test', 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.env.example']) cpSync(join(source, path), join(target, path), { recursive: true, errorOnExist: true, force: false });
    if (kind === 'hub') {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BBM_')));
      env.BBM_DATA_DIR = join(target, '.bbm');
      const result = spawnSync(process.execPath, [join(target, 'bin/bbm.js'), 'hub-init', options['--room'], ...names], { cwd: target, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'Hub initialization failed');
      for (const name of names) {
        const path = join(target, '.bbm', `${name}.env`);
        writeFileSync(path, readFileSync(path, 'utf8').replace('http://127.0.0.1:8787', url.origin) + (allowHttp ? 'BBM_ALLOW_HTTP=true\n' : ''), { mode: 0o600 });
      }
      write(join(target, 'hub.env'), `BBM_DATA_DIR=${JSON.stringify(join(target, '.bbm').replaceAll('\\', '/'))}\nBBM_HOST=${remoteHttp ? '0.0.0.0' : '127.0.0.1'}\nBBM_PORT=8787\n`);
      launchers(target, 'start-hub', { cmd: '--env "%~dp0hub.env" hub', ps: "--env (Join-Path $PSScriptRoot 'hub.env') hub", sh: '--env "$SCRIPT_DIR/hub.env" hub' });
    } else {
      write(join(target, 'personal.env'), personal);
      launchers(target, 'bbm', { cmd: '--env "%~dp0personal.env"', ps: "--env (Join-Path $PSScriptRoot 'personal.env')", sh: '--env "$SCRIPT_DIR/personal.env"' });
      mkdirSync(dirname(skillTarget), { recursive: true });
      mkdirSync(skillTarget); createdSkill = true;
      const skill = readFileSync(join(source, 'skills/bb-multiplayer/SKILL.md'), 'utf8');
      write(join(skillTarget, 'SKILL.md'), `${skill}\n\nInstalled CLI: \`node ${quoteSh(join(target, 'bin/bbm.js'))} --env ${quoteSh(join(target, 'personal.env'))}\`. In PowerShell use: \`& node ${quotePs(join(target, 'bin/bbm.js'))} --env ${quotePs(join(target, 'personal.env'))}\`. Append the operation and its arguments. Use these absolute paths from any project directory.\n`);
    }
    console.log(`Installed ${kind}: ${target}`);
    if (kind === 'hub') console.log(`Run start-hub.cmd (Windows) or ./start-hub (Linux/macOS). Configure hub.env for bind/port. Give each user only .bbm/<name>.env privately.`);
    else console.log(`Run ${join(target, 'bbm.cmd')} status (Windows) or ${join(target, 'bbm')} status. Skill installed: ${skillTarget}. Open a new BB thread.`);
  } catch (error) {
    if (createdSkill) rmSync(skillTarget, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

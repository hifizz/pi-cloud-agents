// M1-00 A1–A6, offline only. Copy this file into the prepared 1.4.0 isolation before running.
// TARSBOT_NO_DOTENV=1 node scratch/m1-probe-a.mjs [a1 ... a6]
// Optional: PROBE_REPEATS=10 (minimum 3). No services, network, real data, or .env reads.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

process.env.TARSBOT_NO_DOTENV = '1';
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const TEMP_ROOT = process.env.PROBE_TEMP_ROOT ?? tmpdir();
const RESULTS = join(ROOT, 'scratch/m1-probe-a-results.json');
const versions = {};
for (const name of ['pi-durable', 'pi-ai', 'chord']) {
  let path = dirname(fileURLToPath(import.meta.resolve(`@earendil-works/${name}`)));
  while (!existsSync(join(path, 'package.json'))) path = dirname(path);
  versions[name] = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version;
}
if (Object.values(versions).some(v => v !== '1.4.0')) {
  console.error(JSON.stringify({ refused: true, reason: 'Requires pi-durable/pi-ai/chord exactly 1.4.0; conclusions from other versions are invalid', versions }));
  process.exit(2);
}
// Set NO_DOTENV before loading any project module, including in child processes.
const { Type } = await import('@earendil-works/pi-ai');
const { createModels } = await import('@earendil-works/pi-ai/models');
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux');
const { AssistantEntry, MemoryStorage, ToolResultEntry, UserEntry, LiveDoc, ToolTask, hook, defineExtension, defineTool, wrapTool } = await import('@earendil-works/pi-durable');
const { ExecutionError, err } = await import('@earendil-works/pi-durable/env');
const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');
const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
const { CodingTools, createReadTool, createWriteTool, createEditTool } = await import('@earendil-works/pi-durable/tools');
const { ctx, openHarness } = await import('../src/harness.mjs');
const { BotRegistry } = await import('../src/bots.mjs');
const { SandboxEnv } = await import('../src/env.mjs');
const FAUX = { provider: 'faux', modelId: 'faux-1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assertions = [];
function check(name, condition, observed) {
  assertions.push({ name, pass: !!condition, ...(observed === undefined ? {} : { observed }) });
}
async function bounded(promise, label, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} (${ms}ms)`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function waitFor(fn, label, ms = 8000) {
  const until = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await sleep(15); } while (Date.now() < until);
  throw new Error(`TIMEOUT: ${label}`);
}
function temp(label) { return mkdtempSync(join(TEMP_ROOT, `${label}-`)); }
function faux(responses) {
  const f = fauxProvider({ tokensPerSecond: 100000 });
  f.setResponses(responses);
  const models = createModels(); models.setProvider(f.provider);
  return { models, f };
}
const call = (name, args, id = 'c1') => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: 'toolUse' });
const answer = text => fauxAssistantMessage([fauxText(text)]);
async function entries(conv) { return (await conv.entries({}, 200, undefined, ctx)).items; }
function brief(e) {
  return { kind: UserEntry.is(e) ? 'user' : AssistantEntry.is(e) ? 'assistant' : ToolResultEntry.is(e) ? 'tool-result' : e.kind,
    model: e.model, ...(ToolResultEntry.is(e) ? { data: e.data } : {}) };
}
const textOf = e => (e?.model?.[0]?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('');
async function newConv(harness, agent = {}) { return harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: FAUX, ...agent } }, ctx); }
async function settle(conv, content = 'go', extra = {}) {
  const sub = await conv.submit({ type: 'input', content, ...extra }, ctx);
  return bounded(sub.wait(ctx), 'submission settlement');
}
async function close(harness) { if (harness) await bounded(harness.close(ctx), 'harness close', 3000); }
function runChild(args, ms = 15000) {
  // Inherit only execution basics, no credentials. Project config is explicitly prevented from loading .env.
  const p = spawn(process.execPath, [SELF, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: TEMP_ROOT, TMPDIR: TEMP_ROOT, PROBE_TEMP_ROOT: TEMP_ROOT, TARSBOT_NO_DOTENV: '1', PROBE_REPEATS: process.env.PROBE_REPEATS ?? '10' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, ms);
  const done = new Promise((resolve, reject) => {
    p.once('error', reject);
    p.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
  return { p, done, out: () => ({ stdout, stderr }) };
}
async function stop(child) { if (child) { if (child.p.exitCode === null && child.p.signalCode === null) child.p.kill('SIGKILL'); await child.done; } }
function resultLine(r) {
  if (r.code !== 0 || r.timedOut) throw new Error(JSON.stringify({ childFailed: r }));
  const line = r.stdout.split('\n').find(x => x.startsWith('RESULT '));
  if (!line) throw new Error(`No RESULT: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

async function a1() {
  const dir = temp('a1'); const out = {};
  const custom = defineTool({ name: 'bash', description: 'CUSTOM bash', parameters: Type.Object({ command: Type.String() }), replay: 'safe',
    async execute(args) { return { output: [{ type: 'text', text: `CUSTOM:${args.command}` }] }; } });
  const mine = defineExtension({ name: 'probe.exec', tools: [custom] });
  const builtin = CodingTools.tools.find(t => t.name === 'bash');
  const wrapped = defineExtension({ name: 'probe.wrap', wraps: [wrapTool(builtin, t => ({ ...t, replay: 'safe', async execute(args, api, c) { return { ...(await t.execute(args, api, c)), details: { wrapped: true } }; } }))] });
  const standalone = defineExtension({ name: 'probe.standalone', tools: [createReadTool(), createWriteTool(), createEditTool(), custom] });
  try {
    for (const [label, extensions, expected] of [
      ['CodingTools,Mine', [CodingTools, mine], 'CUSTOM:echo hi'], ['Mine,CodingTools', [mine, CodingTools], 'hi'],
      ['CodingTools,Wrapped', [CodingTools, wrapped], 'hi'], ['Standalone', [standalone], 'CUSTOM:echo hi'],
    ]) {
      let harness; const offered = [];
      try {
        const { models } = faux([(context) => { offered.push(context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? [])); return call('bash', { command: 'echo hi' }); }, answer('ok')]);
        ({ harness } = await openHarness({ storage: new MemoryStorage(), models, extensions, env: t => new NodeExecutionEnv({ cwd: t.cwd ?? dir }) }));
        const conv = await newConv(harness, { cwd: dir });
        const agent = await conv.agent(ctx);
        await settle(conv);
        const result = (await entries(conv)).find(e => ToolResultEntry.is(e));
        out[label] = { tools: agent.tools.map(t => ({ name: t.name, replay: t.replay })), modelOfferedTools: offered, result: brief(result) };
        check(`${label}: output`, textOf(result).trim() === expected, textOf(result));
        check(`${label}: one offered bash`, offered[0]?.filter(t => t.name === 'bash').length === 1);
      } catch (e) {
        out[label] = { error: String(e.message) };
        check(`${label}: duplicate rejected`, expected === 'duplicate' && /duplicate|already|registered/i.test(e.message), e.message);
      } finally { await close(harness); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

function replayTool(policy, dir, phase) {
  return defineExtension({ name: 'probe.replay', hooks: [hook(ToolTask, { beforeTool: async (_call, api, context) => {
    const binding = await api.memo('initialBinding', { version: 1 }, context);
    appendFileSync(join(dir, 'hooks.jsonl'), JSON.stringify({ phase, taskId: String(api.taskId), binding }) + '\n');
  } })], tools: [defineTool({ name: 'slow', description: 'bounded replay probe', parameters: Type.Object({}), replay: policy,
    async execute(_args, api, context) {
      const bindingBefore = await api.memo('initialBinding', context);
      const bindingCandidate = await api.memo('initialBinding', { version: phase === 'first' ? 1 : 2 }, context);
      const event = { phase, pid: process.pid, callId: api.callId, taskId: String(api.taskId), retainedAtEntry: api.retainedOutput(), bindingBefore, bindingCandidate };
      appendFileSync(join(dir, 'exec.jsonl'), JSON.stringify(event) + '\n');
      for (let i = 0; i < (phase === 'first' ? 2 : 3); i++) {
        api.output(`${phase}:${i}\n`);
        // details() awaits the same progress commit, so the captured live snapshot is durably committed.
        await api.details({ phase, i }, context);
        const live = await api.snapshot(LiveDoc, api.conversationId, context);
        appendFileSync(join(dir, 'live.jsonl'), JSON.stringify({ phase, i, live }) + '\n');
        await sleep(35);
      }
      if (phase === 'first') {
        writeFileSync(join(dir, 'ready'), 'durable first progress captured');
        await sleep(10000); // killed externally, never harness.close() on this process
      }
      return {}; // OUTPUT ONLY: final result must be retained api.output(), never an overriding return text.
    } })] });
}
async function childA2(phase, dir, policy) {
  let harness;
  try {
    const { models } = faux(phase === 'first' ? [call('slow', {}), answer('done')] : [answer('recovered')]);
    ({ harness } = await openHarness({ storage: await openNodeSqliteStorage(join(dir, 'db.sqlite')), models, extensions: [replayTool(policy, dir, phase)], settings: { progress: { partialIntervalMs: 1, outputIntervalMs: 1 } }, resume: false }));
    let conv;
    if (phase === 'first') { conv = await newConv(harness); writeFileSync(join(dir, 'conv'), String(conv.id)); }
    else conv = await harness.conversation(readFileSync(join(dir, 'conv'), 'utf8'), ctx);
    const beforeResume = await harness.snapshot(LiveDoc, conv.id, ctx);
    harness.resume();
    if (phase === 'first') {
      await conv.submit({ type: 'input', content: 'go' }, ctx);
      await new Promise(() => {});
    } else {
      await bounded(conv.waitForIdle(ctx), 'recovered idle');
      console.log('RESULT ' + JSON.stringify({ beforeResume, entries: (await entries(conv)).map(brief) }));
    }
  } finally { await close(harness); }
}
async function a2() {
  const repeats = Number(process.env.PROBE_REPEATS ?? 10);
  if (!Number.isInteger(repeats) || repeats < 3 || repeats > 30) throw new Error('PROBE_REPEATS must be an integer from 3 to 30');
  const out = { repeats, safe: [], unsafe: [] };
  for (const policy of ['safe', 'unsafe']) for (let n = 0; n < repeats; n++) {
    const dir = temp(`a2-${policy}`); let first, second;
    try {
      first = runChild(['child:a2', 'first', dir, policy]);
      await waitFor(() => existsSync(join(dir, 'ready')), 'first durable progress', 10000);
      first.p.kill('SIGKILL'); const killed = await first.done;
      second = runChild(['child:a2', 'second', dir, policy]);
      const restart = resultLine(await second.done);
      const executions = readFileSync(join(dir, 'exec.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const snapshots = readFileSync(join(dir, 'live.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const hooks = readFileSync(join(dir, 'hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const result = restart.entries.find(e => e.kind === 'tool-result');
      const prefix = `${policy}[${n}]`;
      check(`${prefix}: beforeTool runs only before crash`, hooks.length === 1 && hooks[0].phase === 'first', hooks);
      check(`${prefix}: SIGKILL`, killed.signal === 'SIGKILL');
      check(`${prefix}: persisted old progress`, restart.beforeResume?.tools?.[0]?.output === 'first:0\nfirst:1\n', restart.beforeResume);
      check(`${prefix}: execution count`, executions.length === (policy === 'safe' ? 2 : 1), executions.length);
      if (policy === 'safe') {
        check(`${prefix}: stable callId/taskId`, executions[0].callId === executions[1]?.callId && executions[0].taskId === executions[1]?.taskId, executions);
        check(`${prefix}: original binding memo survives`, executions[1]?.bindingBefore?.version === 1 && executions[1]?.bindingCandidate?.version === 1, executions[1]);
        check(`${prefix}: retained reset to zero`, executions[1]?.retainedAtEntry.text === '', executions[1]?.retainedAtEntry);
        check(`${prefix}: first replay progress replaces old`, snapshots.find(s => s.phase === 'second')?.live?.tools?.[0]?.output === 'second:0\n');
        check(`${prefix}: final output only replay`, textOf(result) === 'second:0\nsecond:1\nsecond:2\n', textOf(result));
      } else {
        check(`${prefix}: interrupted error`, result?.model?.[0]?.isError === true, result);
        check(`${prefix}: interrupted preserves prior output`, textOf(result).includes('first:0\nfirst:1\n'), textOf(result));
      }
      out[policy].push({ iteration: n + 1, killed: { signal: killed.signal }, executions, hooks, snapshots, restart });
    } finally { await stop(first); await stop(second); rmSync(dir, { recursive: true, force: true }); }
  }
  out.repeatedCallId = await repeatedCallId();
  return out;
}

async function repeatedCallId() {
  const executions = []; let harness;
  try {
    const ext = defineExtension({ name: 'probe.identity', tools: [defineTool({ name: 'identity', description: 'record IDs', parameters: Type.Object({}), replay: 'safe', async execute(_args, api) {
      executions.push({ conversationId: String(api.conversationId), callId: api.callId, taskId: String(api.taskId) });
      api.output('identity observed'); return {};
    } })] });
    const { models } = faux([call('identity', {}, 'c1'), call('identity', {}, 'c1'), answer('end')]);
    ({ harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [ext] }));
    const conv = await newConv(harness); await settle(conv);
    check('A2 repeated callId: two executions', executions.length === 2, executions);
    check('A2 repeated callId: same conversation and callId', executions[0]?.callId === 'c1' && executions[1]?.callId === 'c1' && executions[0]?.conversationId === executions[1]?.conversationId);
    check('A2 repeated callId: distinct taskId', executions[0]?.taskId !== executions[1]?.taskId);
    return { executions, entries: (await entries(conv)).map(brief) };
  } finally { await close(harness); }
}

async function a3() {
  const dir = temp('a3'); let harness; let id; const stages = []; const ids = []; let calls = 0;
  try {
    for (const phase of ['before restart', 'after restart']) {
      const { models, f } = faux([answer('answer 1'), answer('unexpected answer 2'), answer('unexpected answer 3')]);
      ({ harness } = await openHarness({ storage: await openNodeSqliteStorage(join(dir, 'db.sqlite')), models, extensions: [] }));
      const conv = id ? await harness.conversation(id, ctx) : await newConv(harness); id = conv.id;
      for (const content of phase === 'before restart' ? ['hi', 'hi'] : ['hi', 'different payload']) {
        const sub = await conv.submit({ type: 'input', content, requestId: 'r1' }, ctx); ids.push(String(sub.id));
        await bounded(sub.wait(ctx), 'dedupe settlement'); await bounded(conv.waitForIdle(ctx), 'dedupe idle');
        const all = await entries(conv);
        stages.push({ phase, submitted: content, submissionId: String(sub.id), users: all.filter(UserEntry.is).map(brief), assistants: all.filter(AssistantEntry.is).map(brief), providerCallsThisProcess: f.state.callCount });
      }
      if (phase === 'after restart') {
        try { const sub = await conv.submit({ type: 'write', requestId: 'r1', entry: { kind: 'probe.different' } }, ctx); stages.push({ differentType: 'silently reused', id: String(sub.id) }); }
        catch (e) { stages.push({ differentType: 'throws', error: String(e.message) }); }
      }
      calls += f.state.callCount; await close(harness); harness = undefined;
    }
    check('A3: all input submission IDs equal across restart/payload', new Set(ids).size === 1, ids);
    check('A3: one user and one assistant at all stages', stages.filter(s => s.users).every(s => s.users.length === 1 && s.assistants.length === 1));
    check('A3: one actual provider call total', calls === 1, calls);
    check('A3: different payload silently reuses original', stages[3].users[0].model[0].content === 'hi' && stages[3].providerCallsThisProcess === 0, stages[3]);
    return { ids, totalActualProviderCalls: calls, stages };
  } finally { await close(harness); rmSync(dir, { recursive: true, force: true }); }
}

async function a4() {
  const dir = temp('a4'); const out = {};
  try {
    for (const kind of ['throws', 'failing']) for (const mode of ['tool', 'chat', 'read']) {
      let harness; let envCalls = 0;
      const { models, f } = faux(mode === 'chat' ? [answer('plain-ok')] : [call(mode === 'read' ? 'read' : 'bash', mode === 'read' ? { path: 'absent.txt' } : { command: 'echo hi' }), answer('after-error')]);
      try {
        ({ harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [CodingTools], env: t => {
          envCalls++;
          if (kind === 'throws') throw new Error('workspace not ready: runtime pending');
          const env = new NodeExecutionEnv({ cwd: t.cwd ?? dir });
          env.exec = async () => err(new ExecutionError('spawn_error', 'workspace not ready: runtime pending'));
          return env;
        } }));
        const conv = await newConv(harness, { cwd: dir });
        const settled = await settle(conv);
        const all = await entries(conv); const result = all.find(ToolResultEntry.is);
        out[`${kind}/${mode}`] = { status: settled.status, envCalls, providerCalls: f.state.callCount, entries: all.map(brief) };
        check(`A4 ${kind}/${mode}: settled`, settled.status === 'done');
        if (mode === 'chat') check(`A4 ${kind}/${mode}: chat survives env factory evaluation`, envCalls >= 1 && all.some(e => textOf(e) === 'plain-ok'));
        else check(`A4 ${kind}/${mode}: tool error visible`, result?.model?.[0]?.isError === true, result ? brief(result) : null);
      } catch (e) { out[`${kind}/${mode}`] = { error: String(e.message), envCalls, providerCalls: f.state.callCount }; check(`A4 ${kind}/${mode}: no timeout/unhandled exception`, false, e.message); }
      finally { await close(harness); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

function childA5(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t1(a INTEGER PRIMARY KEY,b INTEGER); CREATE TABLE t2(a INTEGER PRIMARY KEY,b INTEGER)');
  let n = 0; const i1 = db.prepare('INSERT INTO t1 VALUES(?,?)'); const i2 = db.prepare('INSERT INTO t2 VALUES(?,?)');
  const tick = () => { db.exec('BEGIN IMMEDIATE'); try { for (let i = 0; i < 4; i++) { n++; i1.run(n, n * 2); i2.run(n, n * 3); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
  tick(); const timer = setInterval(tick, 20); console.log('READY');
  process.once('SIGTERM', () => { clearInterval(timer); db.close(); process.exit(0); });
}
async function a5() {
  const dir = temp('a5'); let writer, src; const runs = [];
  try {
    check('A5: backup exported', typeof backup === 'function');
    writer = runChild(['child:a5', join(dir, 'live.sqlite')]);
    await waitFor(() => writer.out().stdout.includes('READY'), 'WAL writer ready');
    src = new DatabaseSync(join(dir, 'live.sqlite'));
    for (let i = 0; i < 5; i++) {
      await sleep(70); const path = join(dir, `backup-${i}.sqlite`); const start = Date.now();
      const pages = await bounded(backup(src, path), 'sqlite backup', 3000); const b = new DatabaseSync(path);
      try {
        const integrity = Object.values(b.prepare('PRAGMA integrity_check').get())[0];
        const c1 = b.prepare('SELECT count(*) c FROM t1').get().c; const c2 = b.prepare('SELECT count(*) c FROM t2').get().c;
        const bad1 = b.prepare('SELECT count(*) c FROM t1 WHERE b != a*2').get().c; const bad2 = b.prepare('SELECT count(*) c FROM t2 WHERE b != a*3').get().c;
        const mismatchedKeys = b.prepare('SELECT count(*) c FROM (SELECT a FROM t1 EXCEPT SELECT a FROM t2)').get().c;
        runs.push({ iteration: i + 1, pages, ms: Date.now() - start, integrity, c1, c2, bad1, bad2, mismatchedKeys, bytes: statSync(path).size });
        check(`A5 backup ${i}: consistent`, integrity === 'ok' && c1 === c2 && bad1 === 0 && bad2 === 0 && mismatchedKeys === 0, runs.at(-1));
        if (i) check(`A5 backup ${i}: advancing`, c1 > runs[i - 1].c1);
      } finally { b.close(); }
    }
    return { backupFunction: typeof backup, writer: 'setInterval(20ms), 4 rows in each table per shared transaction', runs };
  } finally {
    src?.close();
    if (writer && writer.p.exitCode === null) writer.p.kill('SIGTERM');
    await stop(writer); rmSync(dir, { recursive: true, force: true });
  }
}

async function a6() {
  const dir = temp('a6'); const missing = join(dir, 'missing', 'workspace'); const out = {};
  try {
    for (const kind of ['NodeExecutionEnv', 'SandboxEnv']) {
      let harness; const targets = [], remoteCommands = [];
      const { models } = faux([call('bash', { command: 'pwd' }, 'bash1'), call('read', { path: 'absent.txt' }, 'read1'), call('write', { path: 'x.txt', content: 'hi' }, 'write1'), answer('end')]);
      try {
        ({ harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [CodingTools], env: t => {
          targets.push({ cwd: t.cwd, conversationId: String(t.conversationId) });
          if (kind === 'NodeExecutionEnv') return new NodeExecutionEnv({ cwd: t.cwd });
          return new SandboxEnv({ cwd: t.cwd, id: 'fake:probe', home: dir, bash: async (command) => {
            remoteCommands.push(command);
            // Deliberately nonexistent fake remote filesystem; never executes the supplied shell script.
            if (command.includes('tarsbot: working directory does not exist')) return { stdout: '', stderr: 'tarsbot: working directory does not exist', exitCode: 125 };
            return { stdout: '', stderr: 'No such file or directory', exitCode: 1 };
          } });
        } }));
        const bots = new BotRegistry(harness, { path: null });
        const bot = await bots.createBot({ name: `cwd-${kind}`, model: FAUX, cwd: missing });
        const conv = await bots.conversation(bot.id); const agent = await conv.agent(ctx);
        const settled = await settle(conv); const all = await entries(conv); const results = all.filter(ToolResultEntry.is);
        out[kind] = { status: settled.status, configuredCwd: missing, resolvedAgentCwd: agent.cwd, envTargets: targets, entries: all.map(brief), fakeRemoteCommands: remoteCommands, localWriteCreatedMissingDirs: existsSync(join(missing, 'x.txt')) };
        check(`A6 ${kind}: cwd forwarded through createBot`, agent.cwd === missing && targets.length > 0 && targets.every(t => t.cwd === missing), targets);
        check(`A6 ${kind}: bash missing cwd error`, results.find(e => e.model?.[0]?.toolName === 'bash')?.model?.[0]?.isError === true, results.map(brief));
        check(`A6 ${kind}: read missing path error`, results.find(e => e.model?.[0]?.toolName === 'read')?.model?.[0]?.isError === true);
        if (kind === 'NodeExecutionEnv') check('A6 Node: write creates cwd parents', existsSync(join(missing, 'x.txt')));
        else check('A6 Sandbox: fake remote was used', remoteCommands.length > 0 && results.find(e => e.model?.[0]?.toolName === 'write')?.model?.[0]?.isError === true);
      } finally { await close(harness); }
      // Remove only directories/files created by this probe before the next control.
      rmSync(join(dir, 'missing'), { recursive: true, force: true });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

const CASES = { a1, a2, a3, a4, a5, a6 };
const mode = process.argv[2];
// A killed parent cannot run finally; each leaf child also has its own hard lifetime limit.
if (mode === 'child:a2' || mode === 'child:a5') setTimeout(() => process.exit(124), 12000).unref();
if (mode === 'child:a2') {
  await childA2(process.argv[3], process.argv[4], process.argv[5]);
} else if (mode === 'child:a5') {
  childA5(process.argv[3]);
} else if (mode === 'child:case') {
  const name = process.argv[3]; const start = Date.now();
  let result, error;
  try { result = await bounded(CASES[name](), name, name === 'a2' ? 55000 : 25000); }
  catch (e) { error = String(e.stack ?? e); check(`${name}: completed`, false, error); }
  await new Promise(resolve => process.stdout.write('RESULT ' + JSON.stringify({ ms: Date.now() - start, result, error, assertions, passed: assertions.filter(a => a.pass).length, failed: assertions.filter(a => !a.pass).length }) + '\n', resolve));
  process.exit(error || assertions.some(a => !a.pass) ? 1 : 0);
} else {
  const wanted = process.argv.slice(2); if (wanted.some(n => !CASES[n])) throw new Error('Only a1..a6 are valid case names');
  const report = { validity: { requiredVersion: '1.4.0', preliminary104: 'INVALID: workspace node_modules 1.0.4 did not match lockfile 1.4.0; excluded from formal conclusions' }, versions, node: process.version, generatedAt: new Date().toISOString(), runner: SELF, temporaryRoot: TEMP_ROOT, repeats: Number(process.env.PROBE_REPEATS ?? 10), cases: {}, passed: 0, failed: 0 };
  for (const name of wanted.length ? wanted : Object.keys(CASES)) {
    const child = runChild(['child:case', name], name === 'a2' ? 58000 : 28000);
    const r = await child.done;
    const line = r.stdout.split('\n').find(s => s.startsWith('RESULT '));
    const result = line ? JSON.parse(line.slice(7)) : { error: 'child did not produce RESULT', stdout: r.stdout, stderr: r.stderr, passed: 0, failed: 1 };
    report.cases[name] = { ...result, exitCode: r.code, signal: r.signal, timedOut: r.timedOut };
    report.passed += result.passed; report.failed += result.failed;
    writeFileSync(RESULTS, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ case: name, ms: result.ms, passed: result.passed, failed: result.failed, error: result.error }));
  }
  console.log(JSON.stringify({ versions, passed: report.passed, failed: report.failed, results: RESULTS }));
  process.exitCode = report.failed ? 1 : 0;
}

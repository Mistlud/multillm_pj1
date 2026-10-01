import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { CodexManager, type CodexChild, type CodexManagerLike } from '../src/server/codex.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { AdapterError, RoomStore, WorkerManager, type AdapterRequest, type Connection } from '../src/core/index.js';

type Message = { id?: number; method: string; params: any };
class FakeChild extends EventEmitter implements CodexChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Message[] = [];
  killed = false;
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(String(chunk)) as Message;
    this.messages.push(message); if (message.method) this.respond(message); done();
  } });
  constructor(private readonly respond: (message: Message) => void) { super(); }
  send(value: unknown): void { if (!this.killed) this.stdout.write(JSON.stringify(value) + '\n'); }
  kill(): boolean { this.killed = true; this.stdout.end(); queueMicrotask(() => this.emit('exit', 0)); return true; }
}
function configReply(home: string): any {
  const config: any = { model_provider: 'openai', forced_login_method: 'chatgpt', approval_policy: 'never', sandbox_mode: 'read-only', project_doc_max_bytes: 0, web_search: 'disabled', cli_auth_credentials_store: 'keyring', agents: { enabled: false }, history: { persistence: 'none' }, memories: { generate_memories: false, use_memories: false }, analytics: { enabled: false }, features: {}, mcp_servers: {}, chatgpt_base_url: 'https://chatgpt.com/backend-api/' };
  const file = join(home, 'config.toml');
  for (const match of readFileSync(file, 'utf8').matchAll(/features\.([a-z_]+)=(false|true)/g)) config.features[match[1]!] = match[2] === 'true';
  return { config, layers: [{ name: { type: 'system' } }, { name: { type: 'user', file } }] };
}
function fixture(options: { account?: string; config?: (value: any) => void; thread?: (value: any) => void; skills?: any[]; intercept?: (message: Message, child: FakeChild) => boolean; turns?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-room-codex-test-'));
  const connection: Connection = { id: 'connection-test', name: 'subscription', type: 'codex', config: { contextTokens: 64000 }, credentialRef: null };
  const children: FakeChild[] = []; const spawns: SpawnOptionsWithoutStdio[] = []; let turns = 0;
  const manager = new CodexManager(dir, {
    environment: { Path: 'fake-path', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'do-not-inherit', CODEX_HOME: 'personal-home', CODEX_ACCESS_TOKEN: 'do-not-inherit', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'do-not-inherit' },
    resolveCommand: () => ({ command: 'fake-codex.exe', prefixArgs: [] }), versionCheck: async () => true,
    spawnFactory: (_command, args, spawnOptions) => {
      assert.deepEqual(args, ['app-server', '--strict-config', '--listen', 'stdio://']); spawns.push(spawnOptions);
      const child = new FakeChild((message) => {
        if (options.intercept?.(message, child) || message.id === undefined) return;
        let result: any = {};
        if (message.method === 'config/read') { result = configReply(spawnOptions.env!.CODEX_HOME!); options.config?.(result); }
        if (message.method === 'skills/list') result = { data: [{ cwd: spawnOptions.cwd, skills: options.skills ?? [], errors: [] }] };
        if (message.method === 'account/read') result = { account: options.account === 'none' ? null : { type: options.account ?? 'chatgpt' } };
        if (message.method === 'account/login/start') result = { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=1', loginId: 'login-test' };
        if (message.method === 'thread/start') { result = { thread: { id: 'thread-test', ephemeral: true }, instructionSources: [] }; options.thread?.(result); }
        if (message.method === 'turn/start') {
          result = { turn: { id: `turn-${turns}`, status: 'inProgress' } };
          // Real notifications may precede the RPC reply; use actual v2 agentMessage.text shape.
          child.send({ method: 'item/completed', params: { threadId: 'thread-test', item: { type: 'userMessage', content: [{ text: 'never include user text in the answer' }] } } });
          child.send({ method: 'item/completed', params: { threadId: 'thread-test', item: { type: 'agentMessage', text: options.turns?.[turns++] ?? '{"action":"wait"}' } } });
          child.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-test', tokenUsage: { last: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 } } } });
          child.send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { status: 'completed' } } });
        }
        child.send({ id: message.id, result });
      }); children.push(child); return child;
    },
  });
  return { manager, connection, children, spawns, dir, async close() { await manager.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('codex isolates environment, instructions and tools and collects only each turn answer', async () => {
  const f = fixture({ turns: ['{"action":"read_post","postId":1}', '{"action":"wait"}'] });
  try {
    const cycle = await f.manager.openCycle(f.connection, 'APP_SYSTEM_ONLY', 'explicit-model');
    const spawn = f.spawns[0]!; assert.equal(spawn.env!.OPENAI_API_KEY, undefined); assert.equal(spawn.env!.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(spawn.env!.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined); assert.notEqual(spawn.env!.CODEX_HOME, 'personal-home');
    assert.equal(spawn.env!.CODEX_HOME, spawn.env!.CODEX_SQLITE_HOME); assert.equal(spawn.cwd, join(f.dir, 'codex', f.connection.id, 'work'));
    assert.match(readFileSync(join(spawn.env!.CODEX_HOME!, 'config.toml'), 'utf8'), /\[\[skills.config\]\]/);
    assert.match(readFileSync(join(spawn.env!.CODEX_HOME!, 'config.toml'), 'utf8'), /imagegen\/SKILL.md/);
    const start = f.children[0]!.messages.find((m) => m.method === 'thread/start')!.params;
    assert.equal(start.ephemeral, true); assert.equal(start.baseInstructions, 'APP_SYSTEM_ONLY'); assert.equal(start.model, 'explicit-model'); assert.equal(start.modelProvider, 'openai');
    assert.deepEqual(start.environments, []); assert.deepEqual(start.dynamicTools, []); assert.deepEqual(start.selectedCapabilityRoots, []);
    const first = await cycle.turn('first input', 'medium'); assert.deepEqual(JSON.parse(first.text), { action: 'read_post', postId: 1 });
    const second = await cycle.turn('read result', 'low'); assert.deepEqual(JSON.parse(second.text), { action: 'wait' });
    assert.equal((second.usage!.last as any).cachedInputTokens, 0);
    await cycle.dispose(); assert.equal(f.children[0]!.killed, true);
  } finally { await f.close(); }
});

test('codex refuses API-key accounts before thread creation', async () => {
  const f = fixture({ account: 'apiKey' });
  try { await assert.rejects(f.manager.openCycle(f.connection, 'app', 'model'), /구독 로그인/); assert.equal(f.children[0]!.messages.some((m) => m.method === 'thread/start'), false); assert.equal(f.children[0]!.killed, true); }
  finally { await f.close(); }
});

test('codex fails closed on personal settings, enabled skills, non-ephemeral threads and instruction sources', async (t) => {
  for (const [name, options] of [
    ['personal config', { config: (v: any) => v.layers.push({ name: { type: 'user', file: 'C:\\personal\\config.toml' } }) }],
    ['MCP config', { config: (v: any) => { v.config.mcp_servers = { personal: {} }; } }],
    ['enabled skill', { skills: [{ enabled: true }] }],
    ['persistent thread', { thread: (v: any) => { v.thread.ephemeral = false; } }],
    ['foreign instructions', { thread: (v: any) => { v.instructionSources = [{ source: 'AGENTS.md' }]; } }],
  ] as const) await t.test(name, async () => {
    const f = fixture(options);
    try { await assert.rejects(f.manager.openCycle(f.connection, 'app', 'model'), /검증|유입/); assert.equal(f.children[0]!.killed, true); assert.equal(f.children[0]!.messages.some((m) => m.method === 'turn/start'), false); }
    finally { await f.close(); }
  });
});

test('codex rejects numeric-ID server tool requests and cleans up failed RPC', async () => {
  const f = fixture({ intercept: (message, child) => {
    if (message.method !== 'turn/start') return false;
    child.send({ id: 900, method: 'item/tool/call', params: { name: 'shell', arguments: {} } }); return true;
  } });
  try { const cycle = await f.manager.openCycle(f.connection, 'app', 'model'); await assert.rejects(cycle.turn('input', 'medium'), /도구|승인/); assert.equal(f.children[0]!.killed, true); }
  finally { await f.close(); }
});

test('codex aborts startup and stop closes live cycles', async () => {
  const controller = new AbortController();
  const f = fixture({ intercept: (message) => { if (message.method === 'initialize') { queueMicrotask(() => controller.abort()); return true; } return false; } });
  try { await assert.rejects(f.manager.openCycle(f.connection, 'app', 'model', controller.signal), /중단/); assert.equal(f.children[0]!.killed, true); }
  finally { await f.close(); }
  const g = fixture();
  try { const cycle = await g.manager.openCycle(g.connection, 'app', 'model'); await g.manager.stop(); assert.equal(g.children[0]!.killed, true); await assert.rejects(cycle.turn('late', 'medium')); }
  finally { await g.close(); }
});

test('codex status restores app authentication and cancel uses the real login ID', async () => {
  const f = fixture();
  try {
    assert.equal((await f.manager.checkStatus(f.connection)).authenticated, true); assert.equal(f.children[0]!.killed, true);
    await f.manager.startLogin(f.connection); assert.equal(f.manager.status(f.connection.id).busy, true);
    const loginChild = f.children.at(-1)!; await f.manager.cancelLogin(f.connection.id);
    assert.deepEqual(loginChild.messages.find((m) => m.method === 'account/login/cancel')!.params, { loginId: 'login-test' });
    assert.equal(loginChild.killed, true); assert.equal(f.manager.status(f.connection.id).busy, false);
    await f.manager.remove(f.connection); assert.equal(f.children.at(-1)!.messages.some((m) => m.method === 'account/logout'), true);
  } finally { await f.close(); }
});

test('cancel during login startup cannot leave a new login process running', async () => {
  let held: { message: Message; child: FakeChild } | undefined;
  const f = fixture({ intercept: (message, child) => {
    if (message.method === 'initialize') { held = { message, child }; return true; } return false;
  } });
  try {
    const pending = f.manager.startLogin(f.connection); void pending.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve)); assert.ok(held);
    await f.manager.cancelLogin(f.connection.id);
    held.child.send({ id: held.message.id, result: {} });
    await assert.rejects(pending, /취소/); assert.equal(held.child.killed, true);
    assert.equal(held.child.messages.some((message) => message.method === 'account/login/start'), false);
  } finally { await f.close(); }
});

function request(signal = new AbortController().signal): AdapterRequest {
  return { participant: { id: 'p', connectionId: 'c', modelId: 'model', modelOptions: {} }, input: { systemPrompt: 'app-only', privateMemo: 'memo', currentThread: { number: 1, messages: [] }, participant: { displayName: 'self' } } as any, history: [], signal };
}
test('codex adapter preserves zero usage on invalid JSON and handles abort while opening', async () => {
  const store = RoomStore.open({ path: ':memory:' }); store.createRoom({ id: 'r', name: 'room' });
  const p = store.addParticipant({ roomId: 'r', displayName: 'self', modelId: 'model', enabled: true });
  store.appendRes({ roomId: 'r', author: { type: 'admin', id: null, displayName: 'admin' }, body: 'hello' });
  const claimed = store.claimCycle({ participantId: p.id, serverRunId: 'run' })!;
  const r = { ...request(), input: claimed.input };
  const f = fixture({ turns: ['not JSON'] });
  try {
    const adapter = new CodexAdapter(f.connection, f.manager);
    await assert.rejects(adapter.run(r), (error: unknown) => error instanceof AdapterError && error.usage?.cachedInputTokens === 0 && error.usage.inputTokens === 12);
    await adapter.dispose(); assert.equal(f.children[0]!.killed, true);
    const controller = new AbortController(); let resolveCycle!: (value: any) => void; let disposed = false;
    const manager = { openCycle: () => new Promise((resolve) => { resolveCycle = resolve; }) } as unknown as CodexManagerLike;
    const abortedAdapter = new CodexAdapter(f.connection, manager);
    const pending = abortedAdapter.run({ ...r, signal: controller.signal }); controller.abort();
    resolveCycle({ turn: () => assert.fail('aborted cycle must not turn'), dispose: async () => { disposed = true; } });
    await assert.rejects(pending, /중단/); assert.equal(disposed, true);
  } finally { store.close(); await f.close(); }
});

test('worker disposes adapters after successful and failed cycles', async () => {
  for (const failed of [false, true]) {
    const store = RoomStore.open({ path: ':memory:' }); store.createRoom({ id: 'r', name: 'room' });
    const p = store.addParticipant({ roomId: 'r', displayName: 'self', modelId: 'model', enabled: true });
    store.appendRes({ roomId: 'r', author: { type: 'admin', id: null, displayName: 'admin' }, body: 'hello' });
    let disposed = 0;
    const workers = new WorkerManager(store, { adapters: () => ({ run: async () => { if (failed) throw new Error('fake failure'); return { action: { action: 'wait' } }; }, dispose: async () => { disposed++; } }) });
    try { await workers.pollNow(p.id); assert.equal(disposed, 1); }
    finally { workers.stop(); store.close(); }
  }
});

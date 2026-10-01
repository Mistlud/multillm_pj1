import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Connection } from '../core/index.js';

const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'multi_agent', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'view_image', 'image_generation', 'workspace_dependencies', 'goals', 'sleep_tool', 'skill_search', 'skill_mcp_dependency_install', 'code_mode_host', 'shell_snapshot', 'guardian_approval', 'auth_elicitation', 'realtime_conversation', 'in_app_local_automation'];
const BUNDLED_SKILLS = ['imagegen', 'openai-docs', 'skill-creator', 'skill-installer', 'review-agent'];
const ENV_ALLOWLIST = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE']);
type Command = { command: string; prefixArgs: string[] };
export interface CodexChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): this;
}
export type CodexSpawnFactory = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => CodexChild;
export interface CodexManagerOptions {
  spawnFactory?: CodexSpawnFactory;
  environment?: NodeJS.ProcessEnv;
  resolveCommand?: () => Command | undefined;
  versionCheck?: (command: Command) => Promise<boolean>;
  onLoginComplete?: (connectionId: string) => void;
}
export interface CodexStatus { available: boolean; authenticated: boolean; busy: boolean; message?: string; }
export interface CodexCycle {
  turn(input: string, effort: string): Promise<{ text: string; usage?: Record<string, unknown> }>;
  dispose(): Promise<void>;
}
export interface CodexManagerLike {
  status(connectionId: string): CodexStatus;
  checkStatus(connection: Connection): Promise<CodexStatus>;
  startLogin(connection: Connection): Promise<{ loginUrl: string }>;
  cancelLogin(connectionId: string): Promise<void>;
  remove(connection: Connection): Promise<void>;
  stop(): Promise<void>;
  openCycle(connection: Connection, baseInstructions: string, model: string, signal?: AbortSignal): Promise<CodexCycle>;
}

/** No raw RPC, stderr, account, or authentication payload is written to application logs. */
class RpcProcess {
  private seq = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private turnWaiter?: { threadId: string; resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
  private text = '';
  private usage?: Record<string, unknown>;
  private readonly lines;
  private readonly exited: Promise<void>;
  constructor(readonly child: CodexChild, private readonly onClose: () => void, onExit: () => void) {
    this.exited = new Promise((resolveExit) => { child.once('exit', resolveExit); child.once('error', resolveExit); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', () => undefined);
    child.stdin.on('error', () => this.close(new Error('Codex 연결에 쓸 수 없습니다.')));
    child.stdout.on('error', () => this.close(new Error('Codex 응답을 읽지 못했습니다.')));
    child.once('exit', () => { this.close(new Error('Codex App Server가 종료되었습니다.')); onExit(); });
    child.once('error', () => { this.close(new Error('Codex App Server를 시작하지 못했습니다.')); onExit(); });
  }
  async initialize(): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'multillm-room', title: 'LLM Room', version: '0.1' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
  }
  call(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex App Server가 종료되었습니다.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Codex 응답 시간이 초과되었습니다: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async turn(threadId: string, input: string, effort: string): Promise<{ text: string; usage?: Record<string, unknown> }> {
    if (this.closed || this.turnWaiter) throw new Error('Codex turn을 시작할 수 없습니다.');
    this.text = ''; this.usage = undefined;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Codex 응답 시간이 초과되었습니다.')), 120_000);
      this.turnWaiter = { threadId, resolve, reject, timer };
    });
    // Completion can arrive before the turn/start reply; rejection must also be observed immediately.
    void done.catch(() => undefined);
    try {
      await this.call('turn/start', { threadId, input: [{ type: 'text', text: input }], effort, environments: [], runtimeWorkspaceRoots: [] });
      await done;
      return { text: this.text, usage: this.usage };
    } catch (error) { this.close(); throw error; }
  }
  close(reason = new Error('Codex 연결을 종료했습니다.')): void {
    if (this.closed) return;
    this.closed = true; this.lines.close();
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(reason); }
    this.pending.clear();
    if (this.turnWaiter) { clearTimeout(this.turnWaiter.timer); this.turnWaiter.reject(reason); this.turnWaiter = undefined; }
    try { this.child.kill(); } catch { /* Already exited. */ }
    this.onClose();
  }
  async waitForExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Codex 프로세스 종료를 확인하지 못했습니다.')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private write(value: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
    catch { this.close(new Error('Codex 연결에 쓸 수 없습니다.')); }
  }
  private onLine(line: string): void {
    if (this.closed) return;
    let value: any;
    try { value = JSON.parse(line); } catch { this.close(new Error('Codex 프로토콜 응답이 올바르지 않습니다.')); return; }
    // App-server requests use IDs too. Never mistake a tool/approval request for our response.
    if (value.method && value.id !== undefined) {
      this.write({ id: value.id, error: { code: -32601, message: 'Tools and approval requests are disabled.' } });
      this.close(new Error('허용되지 않은 Codex 도구 또는 승인 요청을 거부했습니다.')); return;
    }
    if (typeof value.id === 'number') {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.error) pending.reject(new Error('Codex 요청에 실패했습니다. 인증·모델·할당량을 확인하세요.'));
        else pending.resolve(value.result);
      }
      return;
    }
    const method = String(value.method ?? ''); const params = value.params ?? {};
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item ?? {};
      if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item.type)) {
        this.close(new Error('허용되지 않은 Codex 도구 실행을 거부했습니다.')); return;
      }
      if (method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary' && params.threadId === this.turnWaiter?.threadId && typeof item.text === 'string') this.text += item.text;
    }
    if (method === 'thread/tokenUsage/updated' && params.threadId === this.turnWaiter?.threadId) this.usage = params.tokenUsage;
    if (method === 'turn/completed' && params.threadId === this.turnWaiter?.threadId) {
      const waiter = this.turnWaiter!; clearTimeout(waiter.timer); this.turnWaiter = undefined;
      if (params.turn?.status === 'completed') waiter.resolve(undefined);
      else waiter.reject(new Error('Codex 응답이 완료되지 않았습니다. 인증·모델·할당량을 확인하세요.'));
    }
  }
}

function isolatedEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (ENV_ALLOWLIST.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  env.CODEX_HOME = home; env.CODEX_SQLITE_HOME = home;
  return env;
}
function configText(home: string): string {
  const skillDir = join(home, 'skills', '.system');
  const names = new Set([...BUNDLED_SKILLS, ...(existsSync(skillDir) ? readdirSync(skillDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [])]);
  return [
    'model_provider="openai"', 'approval_policy="never"', 'sandbox_mode="read-only"', 'project_doc_max_bytes=0', 'web_search="disabled"',
    'forced_login_method="chatgpt"', 'cli_auth_credentials_store="keyring"', 'agents.enabled=false', 'history.persistence="none"',
    'memories.generate_memories=false', 'memories.use_memories=false', 'analytics.enabled=false',
    ...DISABLED_FEATURES.map((feature) => `features.${feature}=false`), 'features.skip_host_skill_discovery=true',
    ...[...names].flatMap((name) => ['[[skills.config]]', `path=${JSON.stringify(join(skillDir, name, 'SKILL.md').replaceAll('\\', '/'))}`, 'enabled=false']),
  ].join('\n');
}
function versionOk(value: string): boolean {
  const found = /(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(value); if (!found) return false;
  const [major = 0, minor = 0, patch = 0] = found.slice(1).map(Number);
  return major > 0 || minor > 159 || minor === 159 && patch >= 2;
}
function resolveInstalledCommand(environment: NodeJS.ProcessEnv): Command | undefined {
  for (const directory of (environment.Path ?? environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const native = join(directory, 'codex.exe'); if (existsSync(native)) return { command: native, prefixArgs: [] };
    const packageDir = join(directory, 'node_modules', '@openai', 'codex');
    const vendor = join(packageDir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (existsSync(join(directory, 'codex.cmd')) && existsSync(vendor)) return { command: vendor, prefixArgs: [] };
    // Do not spawn a shim/wrapper: killing it could leave its native app-server child alive.
  }
  return undefined;
}

export class CodexManager implements CodexManagerLike {
  private readonly spawnFactory: CodexSpawnFactory;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly resolveCommand: () => Command | undefined;
  private readonly versionCheck: (command: Command) => Promise<boolean>;
  private version?: Promise<boolean>;
  private stopped = false;
  private readonly processes = new Map<RpcProcess, string>();
  private readonly removed = new Set<string>();
  private readonly loginProcesses = new Map<string, { rpc: RpcProcess; loginId?: string }>();
  private readonly loginEpoch = new Map<string, number>();
  private readonly statuses = new Map<string, CodexStatus>();
  private readonly checkedAt = new Map<string, number>();
  private readonly checking = new Map<string, Promise<CodexStatus>>();
  constructor(private readonly dataDir: string, private readonly options: CodexManagerOptions = {}) {
    this.spawnFactory = options.spawnFactory ?? ((command, args, spawnOptions) => spawn(command, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams);
    this.environment = options.environment ?? process.env;
    this.resolveCommand = options.resolveCommand ?? (() => resolveInstalledCommand(this.environment));
    this.versionCheck = options.versionCheck ?? ((command) => this.checkVersion(command));
  }
  status(connectionId: string): CodexStatus {
    return this.statuses.get(connectionId) ?? { available: Boolean(this.resolveCommand()), authenticated: false, busy: false, message: this.resolveCommand() ? undefined : 'Codex CLI 0.159.2 이상을 설치하세요.' };
  }
  async checkStatus(connection: Connection): Promise<CodexStatus> {
    if (this.loginProcesses.has(connection.id) || Date.now() - (this.checkedAt.get(connection.id) ?? 0) < 30_000) return this.status(connection.id);
    const checking = this.checking.get(connection.id); if (checking) return checking;
    const promise = (async () => {
      let rpc: RpcProcess | undefined;
      const epoch = this.loginEpoch.get(connection.id);
      try {
        rpc = await this.start(connection);
        const account = await rpc.call('account/read', {});
        if (epoch === this.loginEpoch.get(connection.id)) this.statuses.set(connection.id, { available: true, authenticated: account?.account?.type === 'chatgpt', busy: false });
      } catch (error) {
        if (epoch === this.loginEpoch.get(connection.id)) this.statuses.set(connection.id, { available: false, authenticated: false, busy: false, message: error instanceof Error ? error.message : 'Codex 상태를 확인하지 못했습니다.' });
      } finally { rpc?.close(); if (rpc) await rpc.waitForExit(); this.checkedAt.set(connection.id, Date.now()); this.checking.delete(connection.id); }
      return this.status(connection.id);
    })();
    this.checking.set(connection.id, promise); return promise;
  }
  async startLogin(connection: Connection): Promise<{ loginUrl: string }> {
    const canceled = this.cancelLogin(connection.id); const epoch = this.loginEpoch.get(connection.id); await canceled;
    const rpc = await this.start(connection); const login = { rpc, loginId: undefined as string | undefined };
    if (epoch !== this.loginEpoch.get(connection.id)) { rpc.close(); await rpc.waitForExit(); throw new Error('Codex 로그인이 취소되었습니다.'); }
    this.loginProcesses.set(connection.id, login); this.statuses.set(connection.id, { available: true, authenticated: false, busy: true });
    try {
      const account = await rpc.call('account/login/start', { type: 'chatgpt' });
      if (epoch !== this.loginEpoch.get(connection.id)) throw new Error('Codex 로그인이 취소되었습니다.');
      const url = new URL(String(account?.authUrl ?? '')); login.loginId = String(account?.loginId ?? '');
      if (!login.loginId || url.protocol !== 'https:' || !(url.hostname === 'openai.com' || url.hostname.endsWith('.openai.com') || url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'))) throw new Error('안전한 ChatGPT 로그인 주소를 받지 못했습니다.');
      void this.watchLogin(connection.id, login); return { loginUrl: url.toString() };
    } catch (error) {
      rpc.close(); await rpc.waitForExit(); if (this.loginProcesses.get(connection.id) === login) this.loginProcesses.delete(connection.id);
      if (epoch === this.loginEpoch.get(connection.id)) this.statuses.set(connection.id, { available: true, authenticated: false, busy: false, message: 'Codex 인증을 시작하지 못했습니다.' }); throw error;
    }
  }
  async cancelLogin(connectionId: string): Promise<void> {
    const epoch = (this.loginEpoch.get(connectionId) ?? 0) + 1; this.loginEpoch.set(connectionId, epoch);
    const login = this.loginProcesses.get(connectionId); this.loginProcesses.delete(connectionId);
    if (login) {
      try { if (login.loginId) await login.rpc.call('account/login/cancel', { loginId: login.loginId }, 3000); } catch { /* Closing the child also cancels authentication. */ }
      login.rpc.close(); await login.rpc.waitForExit();
    }
    const current = this.statuses.get(connectionId); if (current && epoch === this.loginEpoch.get(connectionId)) this.statuses.set(connectionId, { ...current, busy: false });
    this.checkedAt.delete(connectionId);
  }
  async remove(connection: Connection): Promise<void> {
    await this.cancelLogin(connection.id);
    this.removed.add(connection.id);
    const processes = [...this.processes].filter(([, id]) => id === connection.id).map(([rpc]) => rpc);
    for (const rpc of processes) rpc.close(); await Promise.all(processes.map((rpc) => rpc.waitForExit()));
    if (connection.type !== 'codex' || !existsSync(this.homeDir(connection.id))) return;
    let rpc: RpcProcess | undefined;
    try { rpc = await this.start(connection, undefined, true); await rpc.call('account/logout', {}); }
    finally { rpc?.close(); if (rpc) await rpc.waitForExit(); this.statuses.delete(connection.id); this.checkedAt.delete(connection.id); }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.loginProcesses.clear();
    const processes = [...this.processes.keys()]; for (const rpc of processes) rpc.close();
    await Promise.allSettled(processes.map((rpc) => rpc.waitForExit()));
  }
  async openCycle(connection: Connection, baseInstructions: string, model: string, signal?: AbortSignal): Promise<CodexCycle> {
    const rpc = await this.start(connection, signal);
    try {
      const account = await rpc.call('account/read', {});
      if (account?.account?.type !== 'chatgpt') {
        this.statuses.set(connection.id, { available: true, authenticated: false, busy: false });
        throw new Error('앱 전용 ChatGPT 구독 로그인을 완료하세요.');
      }
      this.statuses.set(connection.id, { available: true, authenticated: true, busy: false });
      const started = await rpc.call('thread/start', {
        model, modelProvider: 'openai', cwd: this.workDir(connection.id), ephemeral: true, environments: [], approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions, developerInstructions: 'Return only the requested JSON action. Never request approval or tools.',
        runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], dynamicTools: [],
      });
      const threadId = String(started?.thread?.id ?? '');
      if (!threadId || started?.thread?.ephemeral !== true || !Array.isArray(started?.instructionSources) || started.instructionSources.length !== 0) throw new Error('격리된 Codex thread 검증에 실패했습니다.');
      return { turn: (input, effort) => rpc.turn(threadId, input, effort), dispose: async () => { rpc.close(); await rpc.waitForExit(); } };
    } catch (error) { rpc.close(); await rpc.waitForExit(); throw error; }
  }
  private async start(connection: Connection, signal?: AbortSignal, allowRemoved = false): Promise<RpcProcess> {
    if (connection.type !== 'codex') throw new Error('Codex Connection이 필요합니다.');
    const command = this.resolveCommand();
    if (!command) throw new Error('Codex CLI 0.159.2 이상을 설치한 뒤 다시 시도하세요.');
    if (!await (this.version ??= this.versionCheck(command))) throw new Error('Codex CLI 0.159.2 이상을 설치한 뒤 서버를 재시작하세요.');
    if (this.stopped || signal?.aborted || !allowRemoved && this.removed.has(connection.id)) throw new Error('Codex 요청이 중단되었습니다.');
    const home = this.homeDir(connection.id); mkdirSync(home, { recursive: true }); mkdirSync(this.workDir(connection.id), { recursive: true }); writeFileSync(join(home, 'config.toml'), configText(home), 'utf8');
    let rpc!: RpcProcess;
    const abort = () => rpc.close(new Error('Codex 요청이 중단되었습니다.'));
    rpc = new RpcProcess(this.spawnFactory(command.command, [...command.prefixArgs, 'app-server', '--strict-config', '--listen', 'stdio://'], { cwd: this.workDir(connection.id), env: isolatedEnv(this.environment, home) }), () => signal?.removeEventListener('abort', abort), () => this.processes.delete(rpc));
    this.processes.set(rpc, connection.id); signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await rpc.initialize(); this.verifyConfig(await rpc.call('config/read', { includeLayers: true }), home);
      const skills = await rpc.call('skills/list', { cwds: [this.workDir(connection.id)], forceReload: true });
      if (!Array.isArray(skills?.data) || skills.data.some((entry: any) => !Array.isArray(entry.skills) || entry.skills.some((skill: any) => skill.enabled !== false) || entry.errors?.length)) throw new Error('Codex skills 격리 검증에 실패했습니다.');
      return rpc;
    } catch (error) { rpc.close(); await rpc.waitForExit(); throw error; }
  }
  private verifyConfig(result: any, home: string): void {
    const config = result?.config;
    if (!config || config.model_provider !== 'openai' || config.forced_login_method !== 'chatgpt' || config.approval_policy !== 'never' || config.sandbox_mode !== 'read-only' || config.web_search !== 'disabled' || config.project_doc_max_bytes !== 0 || config.agents?.enabled !== false || config.history?.persistence !== 'none' || config.memories?.generate_memories !== false || config.memories?.use_memories !== false || config.analytics?.enabled !== false || config.cli_auth_credentials_store !== 'keyring') throw new Error('Codex 격리 설정 검증에 실패했습니다.');
    if (DISABLED_FEATURES.some((feature) => config.features?.[feature] !== false) || config.features?.skip_host_skill_discovery !== true) throw new Error('Codex 기능 격리 검증에 실패했습니다.');
    if (Object.keys(config.mcp_servers ?? {}).length || config.instructions || config.developer_instructions || config.model_instructions_file || config.experimental_compact_prompt_file || config.openai_base_url || config.model_providers?.openai || config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/') throw new Error('Codex 외부 설정 유입을 거부했습니다.');
    const ownConfig = resolve(home, 'config.toml').toLowerCase(); const layers = result.layers;
    if (!Array.isArray(layers) || !layers.some((layer: any) => layer.name?.type === 'user' && resolve(layer.name.file).toLowerCase() === ownConfig) || layers.some((layer: any) => {
      const source = layer?.name;
      return source?.type === 'user' ? typeof source.file !== 'string' || resolve(source.file).toLowerCase() !== ownConfig : !['system', 'managed'].includes(source?.type);
    })) throw new Error('Codex 설정 계층 검증에 실패했습니다.');
  }
  private async watchLogin(connectionId: string, login: { rpc: RpcProcess; loginId?: string }): Promise<void> {
    try {
      for (let attempts = 0; attempts < 120; attempts++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.loginProcesses.get(connectionId) !== login) return;
        const account = await login.rpc.call('account/read', {});
        if (account?.account?.type === 'chatgpt') {
          this.statuses.set(connectionId, { available: true, authenticated: true, busy: false });
          this.checkedAt.set(connectionId, Date.now()); this.options.onLoginComplete?.(connectionId); return;
        }
      }
      if (this.loginProcesses.get(connectionId) === login) this.statuses.set(connectionId, { available: true, authenticated: false, busy: false, message: 'Codex 인증 시간이 초과되었습니다.' });
    } catch {
      if (this.loginProcesses.get(connectionId) === login) this.statuses.set(connectionId, { available: true, authenticated: false, busy: false, message: 'Codex 인증 상태를 확인하지 못했습니다.' });
    } finally { login.rpc.close(); await login.rpc.waitForExit().catch(() => undefined); if (this.loginProcesses.get(connectionId) === login) this.loginProcesses.delete(connectionId); }
  }
  private checkVersion(command: Command): Promise<boolean> {
    return new Promise((resolveVersion) => {
      let output = ''; let finished = false;
      const child = this.spawnFactory(command.command, [...command.prefixArgs, '--version'], { cwd: dirname(command.command), env: isolatedEnv(this.environment, join(this.dataDir, 'codex', 'version-home')) });
      const timer = setTimeout(() => done(false), 5000);
      const done = (ok: boolean) => { if (finished) return; finished = true; clearTimeout(timer); try { child.kill(); } catch { /* Complete. */ } resolveVersion(ok); };
      child.stdout.on('data', (chunk) => { output = (output + String(chunk)).slice(0, 2000); }); child.stderr?.on('data', () => undefined);
      child.once('exit', () => done(versionOk(output))); child.once('error', () => done(false));
    });
  }
  private homeDir(id: string): string { this.validateId(id); return resolve(this.dataDir, 'codex', id, 'home'); }
  private workDir(id: string): string { this.validateId(id); return resolve(this.dataDir, 'codex', id, 'work'); }
  private validateId(id: string): void { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Codex Connection ID가 올바르지 않습니다.'); }
}

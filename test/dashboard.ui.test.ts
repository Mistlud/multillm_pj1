import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';

class Node {
  children: Node[] = []; textContent = ''; value = ''; hidden = false; disabled = false;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  events: Record<string, (...args: any[]) => void> = {};
  constructor(readonly tag = 'div') {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, callback: (...args: any[]) => void) { this.events[key] = callback; }
  get selectedOptions() { return this.children.filter((node) => node.value === this.value); }
}
const count = { calling: 0, completed: 1, failed: 0, abandoned: 0, input_blocked: 0 };
const usage = { calls: 2, inputTokens: null, outputTokens: 7, inputKnownCalls: 0, outputKnownCalls: 1 };
const fixture = () => ({
  range: { from: new Date(2026, 9, 2).getTime(), to: new Date(2026, 9, 2, 1).getTime(), timeZone: 'Asia/Seoul', bucket: 'hour' },
  totals: { ...usage, cycles: count, unclassifiedCycles: 1 },
  buckets: [{ ...usage, start: 1, end: 2, label: '2026-10-02 01:00' }],
  participants: [{ ...usage, id: 'old', displayName: 'Old <script> member', deleted: true, cycles: count }],
  choices: { participants: [{ id: 'old', displayName: 'Old <script> member', deleted: true }], connections: [] },
});
function harness() {
  const source = readFileSync(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function dashboardVisible()'), source.indexOf("for (const id of ['dashboard-period'"));
  const nodes = new Map<string, Node>(); const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  node('dashboard-period').value = '7d'; node('dashboard-mode').value = 'real';
  const document = { hidden: false, createElementNS: (_ns: string, tag: string) => new Node(tag), createTextNode: (value: string) => { const item = new Node('text'); item.textContent = value; return item; } };
  const appView = { hidden: false }, shutdownView = { hidden: true }, timers = new Map<number, () => void>(); let timerId = 0;
  const calls: string[] = []; let handler = async (_path: string, _options?: any): Promise<any> => fixture();
  const ui = runInNewContext(transpile(`
    let state = {}, activeTab = 'dashboard', dashboardPeriod = '7d', dashboardMode = 'real', dashboardParticipant = '', dashboardConnection = '';
    let dashboardTimer, dashboardRequest, dashboardEpoch = 0, dashboardPending = false, dashboardFingerprint = '';
    let usageParticipant = '', usageConnection = '', usageBefore, cycleParticipant = '', cycleBefore;
    class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
    function showLogin() { appView.hidden = true; resetDashboard(); }
    function setTab(value) { activeTab = value; pauseDashboard(); }
    ${code}
    ({ syncDashboard, pauseDashboard, resetDashboard, changeDashboardFilters,
       leave: () => { activeTab = 'room'; pauseDashboard(); },
       enter: () => { activeTab = 'dashboard'; syncDashboard(true); },
       logout: showLogin,
       inspect: () => ({ request: Boolean(dashboardRequest), pending: dashboardPending, fingerprint: dashboardFingerprint, usageParticipant }) })
  `), {
    appView, shutdownView, document, AbortController, URLSearchParams, Intl, Date, Set, Map,
    window: { setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) },
    $: node, make: (tag: string, className?: string) => { const item = new Node(tag); if (className) item.setAttribute('class', className); return item; },
    text: (target: Node, value: unknown) => { target.textContent = String(value ?? ''); }, clear: (target: Node) => { target.children = []; target.textContent = ''; },
    api: (path: string, options?: any) => { calls.push(path); return handler(path, options); },
  });
  return { ui, node, document, appView, timers, calls, respond: (fn: typeof handler) => { handler = fn; }, tick: () => { const entry = timers.entries().next().value!; timers.delete(entry[0]); entry[1](); } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const rendered = (node: Node): string => node.textContent + node.children.map(rendered).join('');

test('dashboard polling pauses offscreen, retains unchanged DOM, and rejects stale filter/reset/logout responses', async () => {
  const h = harness(); h.ui.syncDashboard(true); await settle();
  assert.equal(h.calls.length, 1); assert.equal(h.node('dashboard-charts').children.length, 4); assert.equal(h.timers.size, 1);
  const firstChart = h.node('dashboard-charts').children[0];
  h.ui.syncDashboard(); h.ui.syncDashboard(); assert.equal(h.calls.length, 1, 'state polls must not fetch or redraw every four seconds');
  h.respond(async () => { const value = fixture(); value.range.to += 15000; value.buckets[0]!.end += 15000; return value; });
  h.tick(); await settle(); assert.equal(h.calls.length, 2); assert.equal(h.node('dashboard-charts').children[0], firstChart);

  let resolve!: (data: any) => void;
  h.respond(() => new Promise((done) => { resolve = done; })); h.tick();
  h.ui.syncDashboard(true); h.ui.syncDashboard(true); assert.equal(h.calls.length, 3, 'in-flight requests must not overlap');
  h.document.hidden = true; h.ui.pauseDashboard(); resolve(fixture()); await settle();
  assert.equal(h.timers.size, 0); assert.equal(h.node('dashboard-charts').children[0], firstChart);
  h.ui.syncDashboard(true); assert.equal(h.calls.length, 3, 'hidden document does not aggregate');
  h.document.hidden = false; h.ui.syncDashboard(true); assert.equal(h.calls.length, 4);

  h.node('dashboard-mode').value = 'mock'; h.ui.changeDashboardFilters();
  assert.equal(h.calls.length, 4); assert.equal(h.node('dashboard-charts').children.length, 0);
  resolve(fixture()); await settle(); assert.equal(h.calls.length, 5); assert.match(h.calls[4]!, /mode=mock/);
  assert.equal(h.node('dashboard-charts').children.length, 0, 'real response cannot populate mock view');
  resolve(fixture()); await settle(); assert.equal(h.node('dashboard-charts').children.length, 4);

  h.tick(); h.ui.resetDashboard(); h.ui.syncDashboard(true); resolve(fixture()); await settle();
  assert.equal(h.node('dashboard-charts').children.length, 0, 'pre-reset result cannot repopulate reset view');
  h.ui.logout(); resolve(fixture()); await settle();
  assert.equal(h.node('dashboard-charts').children.length, 0); assert.equal(h.timers.size, 0);
  h.ui.enter(); assert.equal(h.calls.length, 7, 'logged-out tab reentry cannot query');
});

test('dashboard shows unknown and partial tokens, deletion labels, keyboard details and participant drilldown', async () => {
  const h = harness(); h.ui.syncDashboard(true); await settle();
  const summary = rendered(h.node('dashboard-summary'));
  assert.match(summary, /입력/);
  assert.match(summary, /미제공/); assert.match(summary, /7 \(일부\)/); assert.match(summary, /0\/2건 제공/);
  const charts = h.node('dashboard-charts').children;
  assert.match(rendered(charts[2]!), /삭제됨/); assert.match(rendered(charts[2]!), /Old <script> member/);
  const descendants = (node: Node): Node[] => [node, ...node.children.flatMap(descendants)];
  const point = descendants(charts[0]!).find((node) => node.tag === 'circle')!;
  assert.equal(point.attributes.tabindex, '0'); point.events.focus!(); assert.match(rendered(charts[0]!), /토큰 제공 입력 0\/2/);
  const participant = descendants(charts[2]!).find((node) => node.tag === 'button' && node.textContent.includes('Old'))!;
  participant.events.click!(); assert.equal(h.ui.inspect().usageParticipant, 'old'); assert.equal(h.timers.size, 0);
});

test('dashboard errors preserve last successful view and retry on the scheduled interval', async () => {
  const h = harness(); h.ui.syncDashboard(true); await settle(); const firstChart = h.node('dashboard-charts').children[0];
  h.respond(async () => { throw new Error('temporary failure'); }); h.tick(); await settle();
  assert.equal(h.node('dashboard-charts').children[0], firstChart); assert.equal(h.node('dashboard-error').hidden, false); assert.equal(h.timers.size, 1);
  h.ui.syncDashboard(); assert.equal(h.calls.length, 2, 'failed request must not create a hot retry loop');
  h.ui.leave(); h.ui.syncDashboard(true); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
});

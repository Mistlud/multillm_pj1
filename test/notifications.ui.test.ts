import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';

class Node {
  textContent = ''; hidden = true; title = ''; scrollTop = 100; scrollHeight = 900;
  attributes: Record<string, string> = {}; events: Record<string, () => void> = {}; classes = new Set<string>();
  feedbackStarts = 0;
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
    add: (name: string) => { if (name === 'click-feedback') this.feedbackStarts++; this.classes.add(name); }, remove: (name: string) => this.classes.delete(name) };
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, callback: () => void) { this.events[name] = callback; }
}
const feed = (lastResId: number, ids: number[] = [], generation = 'generation-a', truncated = false) => ({
  cursor: { generation, lastResId }, items: ids.map((id) => ({ id, kind: 'res', authorName: 'Gemini <script>' })), truncated,
});
function harness() {
  const source = readFileSync(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function scrollRoomToLatest()'), source.indexOf('function createMessage('));
  const stateCode = source.slice(source.indexOf('async function loadState()'), source.indexOf('function renderActive()'));
  const nodes = new Map<string, Node>(); const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const appView = { hidden: false }, shutdownView = { hidden: true }, messages = node('messages');
  const document = { hidden: false, addEventListener: (_name: string, handler: () => void) => { visibility = handler; } }; let visibility!: () => void;
  const timers = new Map<number, { run: () => void; delay: number }>(); let timerId = 0, renderCount = 0;
  const calls: string[] = []; let handler = async (_path: string): Promise<any> => stateFixture(feed(0));
  const dialogs = { open: false, close: () => { dialogs.open = false; } };
  const ui = runInNewContext(transpile(`
    let activeTab = 'board', state = initial, notificationCursor, notificationTimer, notificationBatchCount = 0, notificationBatchTruncated = false, notificationToastExpiresAt = 0;
    let stateContextVersion = 0, stateRequestSequence = 0, stateAppliedSequence = 0, roomEpoch = 0;
    let archiveRequestSequence = 0, usageRequestSequence = 0, cycleRequestSequence = 0, archiveQuery = '', archiveDetail = null, archiveSearchActive = false, archiveFingerprint = '', usageBefore, cycleBefore, errorBefore;
    let dashboardRequest, dashboardTimer;
    ${code}
    ${stateCode}
    function setTab(tab) { activeTab = tab; }
    ({ consumeNotifications, dismissNotificationToast, acknowledgeNotifications, resetNotifications, openNotificationRoom, loadState,
       inspect: () => ({ activeTab, cursor: notificationCursor, stateName: state.room.name, count: notificationBatchCount, context: stateContextVersion }),
       logout: () => { resetNotifications(); appView.hidden = true; } })
  `), {
    initial: stateFixture(feed(0)), messages, appView, shutdownView, document, postDialog: dialogs, cycleDialog: dialogs,
    URLSearchParams, Date, Set, window: {
      setTimeout: (run: () => void, delay: number) => { const id = ++timerId; timers.set(id, { run, delay }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    },
    $: node, roomName: node('room-name'), text: (target: Node, value: unknown) => { target.textContent = String(value ?? ''); }, clear: (target: Node) => { target.textContent = ''; },
    renderActive: () => { renderCount++; }, resetDashboard: () => {}, resetDeletedMemos: () => {}, syncDashboard: () => {}, refreshOpenPost: () => {},
    api: (path: string) => { calls.push(path); return handler(path); },
  });
  return { ui, node, appView, document, messages, timers, visibility: () => visibility(), calls,
    respond: (next: typeof handler) => { handler = next; }, rendered: () => renderCount,
    expire: () => { const [id, value] = [...timers.entries()][0]!; timers.delete(id); value.run(); },
  };
}
function stateFixture(notifications: any, name = 'room') {
  return { room: { name }, thread: { id: 'current', number: 1 }, posts: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, limits: { messageTokens: 100 }, notifications };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('new post toast expires after three seconds while its unread bell persists until clicked', () => {
  const h = harness(); h.ui.consumeNotifications(feed(10, [1, 2]));
  assert.equal(h.node('notification-light').hidden, true, 'initial history establishes a baseline');
  h.ui.consumeNotifications(feed(11, [11]));
  assert.equal(h.node('notification-light').hidden, false); assert.equal(h.node('notification-toast').hidden, false);
  assert.equal([...h.timers.values()][0]!.delay, 3000); assert.equal(h.messages.scrollTop, 100, 'arrival does not move the reading position');
  assert.match(h.node('notification-toast-title').textContent, /Gemini <script>/);
  h.expire(); assert.equal(h.node('notification-toast').hidden, true); assert.equal(h.node('notification-light').hidden, false);
  h.node('notification-bell').events.click!(); assert.equal(h.node('notification-light').hidden, true);
  assert.equal(h.node('notification-bell').feedbackStarts, 1);
  h.node('notification-bell').events.click!(); assert.equal(h.node('notification-bell').feedbackStarts, 2, 'feedback runs without an unread indicator too');
  assert.equal(h.ui.inspect().activeTab, 'board', 'bell only acknowledges without navigating');
  h.ui.consumeNotifications(feed(12, [12])); h.node('notification-toast-open').events.click!();
  assert.equal(h.ui.inspect().activeTab, 'room'); assert.equal(h.messages.scrollTop, h.messages.scrollHeight);
  assert.equal(h.node('notification-light').hidden, true); assert.equal(h.node('notification-toast').hidden, true); assert.equal(h.timers.size, 0);
});

test('notification batches deduplicate replayed ids and retain the bell across hidden tabs', () => {
  const h = harness(); h.ui.consumeNotifications(feed(10)); h.ui.consumeNotifications(feed(12, [11, 12]));
  assert.equal(h.node('notification-toast-title').textContent, '새 글 2개');
  h.ui.consumeNotifications(feed(12, [11, 12])); assert.equal(h.ui.inspect().count, 2); assert.equal(h.timers.size, 1);
  h.ui.consumeNotifications(feed(13, [12, 13])); assert.equal(h.node('notification-toast-title').textContent, '새 글 3개'); assert.equal(h.timers.size, 1);
  h.document.hidden = true; h.visibility(); assert.equal(h.timers.size, 0); assert.equal(h.node('notification-light').hidden, false);
  h.ui.consumeNotifications(feed(14, [14])); assert.equal(h.node('notification-toast').hidden, true); assert.equal(h.node('notification-light').hidden, false);
  h.document.hidden = false; h.ui.consumeNotifications(feed(64, Array.from({ length: 50 }, (_, index) => index + 15), 'generation-a', true));
  assert.equal(h.node('notification-toast-title').textContent, '새 글 50개 이상');
  h.ui.resetNotifications(); assert.equal(h.node('notification-light').hidden, true); assert.equal(h.timers.size, 0);
  h.ui.consumeNotifications(feed(1, [1], 'generation-b')); assert.equal(h.node('notification-light').hidden, true, 'reset baseline cannot revive pre-reset notifications');
});

test('state refresh ignores out-of-order and post-logout responses and carries its notification cursor', async () => {
  const h = harness(); h.respond(async () => stateFixture(feed(10))); await h.ui.loadState();
  assert.equal(h.calls[0], '/api/state');
  const pending: Array<(value: any) => void> = [];
  h.respond(() => new Promise((resolve) => pending.push(resolve)));
  const first = h.ui.loadState(), second = h.ui.loadState();
  assert.match(h.calls[1]!, /notificationGeneration=generation-a&notificationAfter=10/);
  pending[1]!(stateFixture(feed(12, [11, 12]), 'latest')); await second;
  const renders = h.rendered(); pending[0]!(stateFixture(feed(11, [11]), 'stale')); await first;
  assert.equal(h.ui.inspect().stateName, 'latest'); assert.equal(h.rendered(), renders); assert.equal(h.ui.inspect().count, 2);
  const afterLogout = h.ui.loadState(); h.ui.logout(); pending[2]!(stateFixture(feed(13, [13]), 'late secret')); await afterLogout; await settle();
  assert.equal(h.ui.inspect().stateName, 'latest'); assert.equal(h.node('notification-toast').hidden, true); assert.equal(h.node('notification-light').hidden, true);
});

test('stale state failures cannot interrupt newer state or a new login context', async () => {
  const h = harness();
  const pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  h.respond(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const stale = h.ui.loadState(), fresh = h.ui.loadState();
  pending[1]!.resolve(stateFixture(feed(10), 'latest')); assert.equal(await fresh, true);
  pending[0]!.reject(new Error('old connection failure')); assert.equal(await stale, false);
  assert.equal(h.ui.inspect().stateName, 'latest');
  const oldSession = h.ui.loadState(); h.ui.logout(); h.appView.hidden = false;
  h.respond(async () => stateFixture(feed(12), 'new session')); assert.equal(await h.ui.loadState(), true);
  pending[2]!.reject(new Error('로그인 401')); assert.equal(await oldSession, false);
  assert.equal(h.ui.inspect().stateName, 'new session'); assert.equal(h.appView.hidden, false);
});

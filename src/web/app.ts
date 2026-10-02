type Author = { displayName: string };
type Message = { id: number; threadId: string; threadNumber: number; number: number; author: Author; body: string; postId: number | null; createdAt: number };
type Thread = { id: string; number: number; status: "open" | "closed"; resCount: number; deletedAt?: number | null };
type PostMeta = { id: number; author: Author; title: string; createdAt: number; deletedAt?: number | null };
type Post = PostMeta & { body: string };
type Connection = { id: string; name: string; type: string; config: Record<string, unknown>; hasCredential: boolean };
type CodexStatus = { available: boolean; authenticated: boolean; busy: boolean; message?: string };
type Participant = { id: string; displayName: string; enabled: boolean; connectionId: string | null; modelId: string; modelOptions: Record<string, unknown>; systemPrompt: string; runtime: { status: string; nextPollAt: number | null; lastError: string | null; activeCycleId?: string | null; observed?: { threadNumber?: number } | null }; cycleState?: { activeStartedAt?: number | null; lastCompletedAt?: number | null; lastAction?: string | null; observedThreadNumber?: number | null } };
type ParticipantMemo = { participantId: string; displayName: string; privateMemo: string; updatedAt: number; deletedAt: number | null };
type CorePromptRecord = { name: string; adapter: string; text: string };
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
type State = { room: { name: string }; thread: Thread; messages: Message[]; participants: Participant[]; participantMemos: ParticipantMemo[]; connections: Connection[]; posts: PostMeta[]; threads: Thread[]; usage: { calls: number; inputTokens: number; outputTokens: number }; limits: { messageTokens: number }; lanAddresses: string[]; timeZone?: string };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const loginView = $("login-view"), appView = $("app-view"), shutdownView = $("shutdown-view");
const loginForm = $("login-form") as HTMLFormElement, loginToken = $("login-token") as HTMLInputElement;
const messages = $("messages"), roomName = $("room-name"), threadTitle = $("thread-title"), threadCount = $("thread-count"), appError = $("app-error"), loginError = $("login-error");
const resForm = $("res-form") as HTMLFormElement, resMessage = $("res-message") as HTMLTextAreaElement;
const postDialog = $("post-dialog") as HTMLDialogElement;
const cycleDialog = $("cycle-dialog") as HTMLDialogElement;
const corePromptEditor = $('core-prompt-template') as HTMLTextAreaElement;
let archiveSearchActive = false;
let archiveQuery = '', archiveDetail: { thread: number; res?: number } | null = null, archiveFingerprint = '';
let archiveRequestSequence = 0, usageRequestSequence = 0, cycleRequestSequence = 0, errorRequestSequence = 0, roomEpoch = 0;
let usageParticipant = '', usageConnection = '', cycleParticipant = '', usageBefore: number | undefined, cycleBefore: number | undefined, errorBefore: number | undefined, selectedError: number | undefined;
const reportedMessages = new Set<string>();
let state: State | null = null;
let activeTab = "room";
let refreshTimer: number | undefined;
let roomFingerprint = "", boardFingerprint = "", memoFingerprint = "", manageFingerprint = "";
let promptsLoading = false;
let savedCorePrompt: string | undefined, latestCorePrompt: string | undefined, promptSaving = false;
let editingConnectionId: string | null = null;
const deletingConnectionIds = new Set<string>();
let deletedMemos: ParticipantMemo[] = [], deletedMemoStateVersion = -1, memoStateVersion = 0, memoRequestSequence = 0, deletedMemosLoading = false, showDeletedMemos = false;
let memoContextVersion = 0, memoFailedStateVersion = -1;
const deletingMemoIds = new Set<string>();
const deletingParticipantIds = new Set<string>();
const codexLoginUrls = new Map<string, string>();
const codexStatusRequests = new Set<string>();

function clear(node: Element): void { while (node.firstChild) node.removeChild(node.firstChild); }
function text(node: Node, value: unknown): void { node.textContent = String(value ?? ""); }
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (className) node.className = className; return node; }
function showError(message: string, login = false): void { const target = login ? loginError : appError; text(target, message); target.hidden = false; const recorded = reportedMessages.delete(message); if (!login && !recorded) void fetch('/api/errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ message }) }).catch(() => undefined); }
function hideError(login = false): void { (login ? loginError : appError).hidden = true; }
function fmtTime(value: number): string { return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: state?.timeZone }).format(new Date(value)); }
function secondsUntil(value: number | null): string { if (!value) return "예약 없음"; const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000)); return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 후 확인` : "곧 확인"; }

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers); if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) { const message = typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : "요청에 실패했습니다."; if (typeof payload === 'object' && payload !== null && 'errorId' in payload && (payload as any).errorId) reportedMessages.add(message); throw new ApiError(message, response.status); }
  return payload as T;
}

async function loadState(): Promise<void> {
  const next = await api<State>("/api/state");
  if (state && state.thread.id !== next.thread.id && next.thread.number === 1) { roomEpoch++; resetDeletedMemos(); archiveRequestSequence++; usageRequestSequence++; cycleRequestSequence++; archiveQuery = ''; archiveDetail = null; archiveSearchActive = false; archiveFingerprint = ''; usageBefore = cycleBefore = errorBefore = undefined; if (postDialog.open) postDialog.close(); if (cycleDialog.open) cycleDialog.close(); clear($('archive-result')); }
  if (postDialog.open) { const post = next.posts.find((item) => String(item.id) === postDialog.dataset.postId); if (post?.deletedAt != null) { text($('dialog-post-title'), post.title); text($('dialog-post-body'), '관리자에 의해 삭제된 게시글입니다.'); } }
  if (postDialog.open && postDialog.dataset.postId) void refreshOpenPost(postDialog.dataset.postId);
  state = next; roomName.textContent = next.room.name; $("res-limit").textContent = `공통 한도 ${next.limits.messageTokens} tokens`;
  $("usage-summary").textContent = `호출 ${next.usage.calls} · 입력 ${next.usage.inputTokens.toLocaleString()} · 출력 ${next.usage.outputTokens.toLocaleString()}`;
  $("connection-state").textContent = "로컬 연결됨";
  renderActive();
}

function renderActive(): void {
  if (!state) return;
  if (activeTab === "room") renderRoom();
  if (activeTab === "board") renderBoard();
  if (activeTab === "archive") renderArchiveThreads();
  if (activeTab === "memos") renderMemos();
  if (activeTab === "manage") renderManagement();
  if (activeTab === "usage") void renderUsage();
  if (activeTab === "cycles") void renderCycles();
  if (activeTab === "errors") void renderErrors();
}

function renderRoom(): void {
  if (!state) return;
  threadTitle.textContent = '현재 불판';
  threadCount.textContent = `${state.thread.resCount} / 1000`;
  const fingerprint = state.thread.id + state.messages.map((item) => `${item.id}:${item.body}:${item.postId}`).join("|");
  if (fingerprint === roomFingerprint) return;
  const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  roomFingerprint = fingerprint; clear(messages);
  for (const message of state.messages) messages.append(createMessage(message));
  if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
}

function scrollRoomToLatest(): void {
  if (activeTab === 'room' && !appView.hidden) messages.scrollTop = messages.scrollHeight;
}

function createMessage(message: Message, archive = false): HTMLElement {
  const row = make("article", "message"); const head = make("div", "message-head");
  const author = make("span", "message-author"); text(author, message.author.displayName);
  const no = make("span", "message-no"); text(no, `${archive ? `T${message.threadNumber}-R` : 'R'}${message.number} · ${fmtTime(message.createdAt)}`); head.append(no, author);
  const body = make("div", "message-body"); appendMessageText(body, message.body); row.append(head, body); return row;
}

function appendMessageText(target: HTMLElement, value: string): void {
  const pattern = />>P(\d+)/g; let last = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    target.append(document.createTextNode(value.slice(last, match.index)));
    const button = make("button", "post-reference"); button.type = "button"; button.dataset.postId = match[1]!; text(button, match[0]); target.append(button); last = pattern.lastIndex;
  }
  target.append(document.createTextNode(value.slice(last)));
}

function renderBoard(): void {
  if (!state) return;
  const fingerprint = state.posts.map((post) => `${post.id}:${post.title}:${post.createdAt}`).join("|"); if (fingerprint === boardFingerprint) return;
  boardFingerprint = fingerprint; const list = $("post-list"); clear(list);
  if (!state.posts.length) { const empty = make("p", "muted"); text(empty, "아직 Big Board 글이 없습니다."); list.append(empty); return; }
  for (const post of state.posts) { const card = make("article", "post-card"); const info = make("div"); const title = make("h3"); text(title, post.title); const meta = make("p", "fine"); text(meta, `P${post.id} · ${post.author.displayName} · ${fmtTime(post.createdAt)}${post.deletedAt ? ' · 삭제됨' : ''}`); info.append(title, meta); const open = make("button"); open.type = "button"; open.dataset.postId = String(post.id); text(open, "본문 열기"); const remove = make('button', 'danger'); remove.type = 'button'; text(remove, '삭제'); remove.addEventListener('click', async () => { if (!window.confirm(`P${post.id}을 삭제할까요?`)) return; try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : '게시글을 삭제하지 못했습니다.'); } }); card.append(info, open, remove); list.append(card); }
}

function renderArchiveThreads(): void {
  if (!state) return;
  const select = $("archive-thread") as HTMLSelectElement; const previous = select.value; clear(select);
  for (const thread of state.threads.filter((thread) => thread.status === 'closed')) { const option = make("option") as HTMLOptionElement; option.value = String(thread.number); text(option, `T${thread.number} · ${thread.resCount}레스${thread.deletedAt != null ? ' · 삭제됨' : ''}`); select.append(option); }
  select.value = [...select.options].some((item) => item.value === previous) ? previous : select.options[0]?.value ?? '';
  const batches = $('delete-threads') as HTMLButtonElement; batches.disabled = false;
  const batch = $('delete-threads').parentElement!; const checked = new Set([...batch.querySelectorAll<HTMLInputElement>('[data-thread-delete]:checked')].map((item) => item.value)); batch.querySelector('.thread-select-list')?.remove(); const list = make('div', 'thread-select-list');
  for (const thread of state.threads.filter((item) => item.status === 'closed')) { const label = make('label'); const box = make('input') as HTMLInputElement; box.type = 'checkbox'; box.value = String(thread.number); box.checked = checked.has(box.value); box.disabled = thread.deletedAt != null; box.dataset.threadDelete = ''; label.append(box, document.createTextNode(` T${thread.number} · ${thread.resCount}레스${thread.deletedAt != null ? ' · 삭제됨' : ''}`)); list.append(label); }
  if (list.childElementCount) batch.append(list);
  const fingerprint = JSON.stringify(state.threads.map((thread) => [thread.id, thread.deletedAt, thread.resCount])) + select.value;
  if (fingerprint === archiveFingerprint) return; archiveFingerprint = fingerprint;
  if (archiveDetail) void loadThread(archiveDetail.thread, archiveDetail.res);
  else if (archiveSearchActive) void searchArchive();
  else if (select.value) void loadThread(Number(select.value));
  else { clear($('archive-result')); text($('archive-result'), '종료된 불판이 없습니다.'); }
}

async function loadThread(number: number, highlight?: number): Promise<void> {
  const sequence = ++archiveRequestSequence;
  try { const payload = await api<{ thread: Thread; messages: Message[] }>(`/api/threads/${number}`); if (sequence !== archiveRequestSequence) return; renderArchiveMessages(payload.messages, `T${payload.thread.number}${payload.thread.deletedAt != null ? ' · 관리자에 의해 삭제된 불판입니다.' : ' 원문'}`, highlight); } catch (error) { if (sequence !== archiveRequestSequence) return; clear($('archive-result')); showError(error instanceof Error ? error.message : "Archive를 열 수 없습니다."); }
}
function renderArchiveMessages(items: Message[], title: string, highlight?: number): void { const target = $("archive-result"); clear(target); const heading = make("p", "fine"); text(heading, title); target.append(heading); for (const item of items) { const row = createMessage(item, true); if (highlight === item.number) { row.classList.add('highlight'); setTimeout(() => { row.scrollIntoView({ block: 'center' }); setTimeout(() => row.classList.remove('highlight'), 5000); }, 0); } target.append(row); } }
async function searchArchive(): Promise<void> {
  const sequence = ++archiveRequestSequence;
  try { const found = await api<Message[]>(`/api/archive?q=${encodeURIComponent(archiveQuery)}`); if (sequence !== archiveRequestSequence || !archiveSearchActive || archiveDetail) return; const target = $('archive-result'); clear(target); const heading = make('p', 'fine'); text(heading, `“${archiveQuery}” 검색 결과 ${found.length}개`); target.append(heading);
    for (const item of found) { const card = make('article', 'archive-message'); const position = item.body.toLocaleLowerCase().indexOf(archiveQuery.toLocaleLowerCase()); const start = Math.max(0, position - 80); const snippet = (start ? '…' : '') + item.body.slice(start, start + 240) + (item.body.length > start + 240 ? '…' : ''); const refs = [...new Set(item.body.match(/>>P\d+/g) ?? [])].filter((ref) => !snippet.includes(ref)); card.append(createMessage({ ...item, body: snippet + (refs.length ? '\n' + refs.join(' ') : '') }, true)); const open = make('button'); text(open, '해당 레스 열기'); open.addEventListener('click', () => { archiveDetail = { thread: item.threadNumber, res: item.number }; ($('archive-back') as HTMLButtonElement).hidden = false; void loadThread(item.threadNumber, item.number); }); const copy = make('button', 'quiet'); text(copy, '식별자 복사'); copy.addEventListener('click', () => void copyText(`T${item.threadNumber}-R${item.number}`)); card.append(open, copy); target.append(card); }
    if (!found.length) record(target, '검색 결과', '검색된 레스가 없습니다.');
  } catch (error) { clear($('archive-result')); showError(error instanceof Error ? error.message : '검색에 실패했습니다.'); }
}

function renderMemos(): void {
  if (!state || activeTab !== 'memos' || appView.hidden) return;
  const staleDeletedMemos = showDeletedMemos && deletedMemoStateVersion !== memoStateVersion;
  const shown = showDeletedMemos && !staleDeletedMemos ? [...state.participantMemos, ...deletedMemos] : state.participantMemos;
  const retryDeletedMemos = staleDeletedMemos && memoFailedStateVersion !== memoStateVersion;
  const fingerprint = JSON.stringify({ shown, showDeletedMemos, staleDeletedMemos, retryDeletedMemos, deletedMemosLoading, deleting: [...deletingMemoIds] }); if (fingerprint === memoFingerprint) return;
  memoFingerprint = fingerprint; const list = $("memo-list"); clear(list);
  const controls = make('label', 'memo-toggle'); const toggle = make('input') as HTMLInputElement; toggle.type = 'checkbox'; toggle.checked = showDeletedMemos; toggle.addEventListener('change', () => { showDeletedMemos = toggle.checked; invalidateDeletedMemos(); renderMemos(); }); controls.append(toggle, document.createTextNode(' 삭제된 참가자 메모 표시')); list.append(controls);
  if (!shown.length) { const empty = make("p", "muted"); text(empty, "표시할 Private Memo가 없습니다."); list.append(empty); }
  for (const memo of shown) {
    const card = make("article", "memo-card"); const name = make("h3"); text(name, memo.displayName);
    const meta = make("p", "fine"); text(meta, memo.deletedAt === null ? `현재 참가자 · 최종 갱신 ${fmtTime(memo.updatedAt)}` : `삭제됨 · 삭제 ${fmtTime(memo.deletedAt)}`);
    const body = make("div", `memo-body${memo.privateMemo ? "" : " muted"}`); text(body, memo.privateMemo || "(비어 있음)"); card.append(name, meta, body);
    if (memo.deletedAt !== null && memo.privateMemo) { const remove = make('button', 'danger'); remove.type = 'button'; remove.disabled = deletingMemoIds.has(memo.participantId); text(remove, remove.disabled ? '삭제 중…' : '현재 메모 비우기'); remove.addEventListener('click', () => void clearDeletedMemo(memo)); card.append(remove); }
    list.append(card);
  }
  if (retryDeletedMemos && !deletedMemosLoading && !deletingMemoIds.size) void loadDeletedMemos();
}
function invalidateDeletedMemos(): void {
  memoRequestSequence++; memoStateVersion++; deletedMemoStateVersion = -1; memoFailedStateVersion = -1; deletedMemosLoading = false; memoFingerprint = '';
}
async function clearDeletedMemo(memo: ParticipantMemo): Promise<void> {
  if (deletingMemoIds.has(memo.participantId) || !window.confirm('현재 보존 메모만 삭제하며 과거 Cycle 기록은 유지됩니다. 이 메모를 비울까요?')) return;
  const context = memoContextVersion;
  deletingMemoIds.add(memo.participantId); invalidateDeletedMemos();
  deletedMemos = []; renderMemos();
  try {
    await api(`/api/participants/${memo.participantId}/memo`, { method: 'DELETE' });
    if (context !== memoContextVersion || appView.hidden) return;
    await refresh();
  } catch (error) {
    if (context === memoContextVersion && !appView.hidden) showError(error instanceof Error ? error.message : '현재 메모를 비우지 못했습니다.');
  } finally {
    if (context === memoContextVersion) {
      deletingMemoIds.delete(memo.participantId); invalidateDeletedMemos(); renderMemos();
    }
  }
}
async function loadDeletedMemos(): Promise<void> { const request = ++memoRequestSequence, version = memoStateVersion; deletedMemosLoading = true; memoFingerprint = ''; renderMemos(); try { const memos = await api<ParticipantMemo[]>('/api/participant-memos?includeDeleted=1'); if (request !== memoRequestSequence || version !== memoStateVersion || !showDeletedMemos) return; deletedMemos = memos.filter((memo) => memo.deletedAt !== null); deletedMemoStateVersion = version; memoFailedStateVersion = -1; } catch (error) { if (request === memoRequestSequence && version === memoStateVersion && showDeletedMemos) { memoFailedStateVersion = version; showError(error instanceof Error ? error.message : '삭제된 참가자 메모를 불러오지 못했습니다.'); } } finally { if (request === memoRequestSequence) { deletedMemosLoading = false; memoFingerprint = ''; renderMemos(); } } }

function renderManagement(): void {
  if (!state) return;
  const fingerprint = JSON.stringify({ participants: state.participants.map((p) => [p.id, p.displayName, p.enabled, p.connectionId, p.modelId, p.runtime.status, p.runtime.lastError]), connections: state.connections, lan: state.lanAddresses });
  if (fingerprint === manageFingerprint) { refreshCountdowns(); refreshCodexStatuses(); return; }
  manageFingerprint = fingerprint; renderParticipants(); renderConnections(); renderConnectionChoices(); renderLan();
}
function renderParticipants(): void {
  if (!state) return; const list = $("participant-list"); clear(list);
  if (!state.participants.length) { const empty = make("p", "muted"); text(empty, "참가자가 없습니다. Connection을 만든 뒤 추가하세요."); list.append(empty); return; }
  for (const participant of state.participants) {
    const card = make("article", "participant-card"); const info = make("div"); const name = make("h3"); text(name, participant.displayName); const meta = make("div", "participant-meta");
    for (const label of [participant.modelId, participant.enabled ? 'ON' : 'OFF', participant.runtime.status, participant.cycleState?.activeStartedAt ? `실행 ${fmtTime(participant.cycleState.activeStartedAt)}` : `마지막 ${participant.cycleState?.lastCompletedAt ? fmtTime(participant.cycleState.lastCompletedAt) : '-'}`, `Action ${participant.cycleState?.lastAction ?? '-'}`, `관측 T${participant.cycleState?.observedThreadNumber ?? participant.runtime.observed?.threadNumber ?? '-'}`, participant.runtime.lastError ? `오류: ${participant.runtime.lastError}` : "오류 없음"]) { const span = make("span"); text(span, label); meta.append(span); }
    const schedule = make("span", "participant-meta countdown"); schedule.dataset.participantId = participant.id; text(schedule, secondsUntil(participant.runtime.nextPollAt)); info.append(name, meta, schedule);
    const actions = make("div"); const toggle = make("button", `switch${participant.enabled ? "" : " off"}`); toggle.type = "button"; toggle.dataset.toggleId = participant.id; text(toggle, participant.enabled ? "ON · 다음 확인" : "OFF · 멈춤"); const remove = make("button", "danger") as HTMLButtonElement; remove.type = "button"; remove.dataset.participantDeleteId = participant.id; text(remove, "삭제"); actions.append(toggle, remove); card.append(info, actions);
    const details = make("details"); const summary = make("summary"); text(summary, "참가자 설정"); details.append(summary, participantEditForm(participant)); card.append(details); list.append(card);
  }
}
function participantEditForm(participant: Participant): HTMLFormElement {
  const form = make("form", "stack form-grid") as HTMLFormElement; form.dataset.participantId = participant.id;
  form.append(field("표시 이름", "displayName", participant.displayName), selectField("Connection", "connectionId", state?.connections ?? [], participant.connectionId), field("모델 ID", "modelId", participant.modelId), field("추론 강도", "reasoningEffort", String(participant.modelOptions.reasoningEffort ?? participant.modelOptions.thinkingLevel ?? "")), textAreaField("모델 옵션 JSON", "modelOptions", JSON.stringify(participant.modelOptions)), textAreaField("System Prompt", "systemPrompt", participant.systemPrompt, true));
  const button = make("button", "primary") as HTMLButtonElement; button.type = "submit"; text(button, "참가자 설정 저장"); const preview = make("button", "quiet") as HTMLButtonElement; preview.type = "button"; preview.textContent = "실제 입력 미리보기"; preview.addEventListener("click", () => void showPreview(participant.id)); form.append(button, preview); configureReasoning(form); form.querySelector('[name=connectionId]')?.addEventListener('change', () => configureReasoning(form)); return form;
}
function configureReasoning(form: HTMLFormElement): void { const connectionId = form.querySelector<HTMLSelectElement>('[name=connectionId]')?.value; const type = state?.connections.find((item) => item.id === connectionId)?.type; const input = form.querySelector<HTMLInputElement>('[name=reasoningEffort]'); if (!input) return; input.maxLength = 200; input.disabled = type !== 'vertex' && type !== 'codex'; input.placeholder = type === 'vertex' ? 'thinkingLevel · 빈 값은 Provider 기본값' : type === 'codex' ? 'reasoningEffort · 빈 값은 Provider 기본값' : '이 Adapter는 추론 옵션을 매핑하지 않습니다.'; }
function field(labelText: string, name: string, value: string): HTMLLabelElement { const label = make("label"); text(label, labelText); const input = make("input") as HTMLInputElement; input.name = name; input.value = value; label.append(input); return label; }
function numberField(labelText: string, name: string, value: string): HTMLLabelElement { const label = field(labelText, name, value); const input = label.querySelector("input")!; input.type = "number"; input.min = "1024"; input.max = "2000000"; return label; }
function urlField(labelText: string, name: string, value: string): HTMLLabelElement { const label = field(labelText, name, value); label.querySelector("input")!.type = "url"; return label; }
function textAreaField(labelText: string, name: string, value: string, wide = false): HTMLLabelElement { const label = make("label", wide ? "wide" : ""); text(label, labelText); const area = make("textarea") as HTMLTextAreaElement; area.name = name; area.rows = name === "systemPrompt" ? 4 : 3; area.value = value; label.append(area); return label; }
function selectField(labelText: string, name: string, items: Connection[], selected: string | null): HTMLLabelElement { const label = make("label"); text(label, labelText); const select = make("select") as HTMLSelectElement; select.name = name; for (const item of items) { const option = make("option") as HTMLOptionElement; option.value = item.id; option.selected = item.id === selected; text(option, item.name); select.append(option); } label.append(select); return label; }
function refreshCountdowns(): void { if (!state) return; for (const node of document.querySelectorAll<HTMLElement>(".countdown")) { const participant = state.participants.find((item) => item.id === node.dataset.participantId); if (participant) text(node, secondsUntil(participant.runtime.nextPollAt)); } }
function renderConnections(): void {
  if (!state) return;
  const list = $("connection-list");
  if (editingConnectionId && !state.connections.some((connection) => connection.id === editingConnectionId)) {
    for (const input of list.querySelectorAll<HTMLTextAreaElement>('textarea[name="credential"]')) input.value = "";
    editingConnectionId = null;
  }
  if (editingConnectionId && list.querySelector(`form[data-connection-id="${editingConnectionId}"]`)) return;
  clear(list);
  for (const connection of state.connections) {
    const card = make("article", "connection-card"); const left = make("div"); const title = make("strong"); text(title, connection.name);
    const details = make("p"); text(details, `${connection.type} · ${connection.type === "codex" ? "ChatGPT 구독 인증" : connection.hasCredential ? "인증정보 연결됨" : "인증정보 없음"} · context ${String(connection.config.contextTokens ?? "기본")}`); left.append(title, details);
    if (connection.type === "codex") left.append(codexControls(connection));
    if (editingConnectionId === connection.id) card.append(connectionEditForm(connection));
    else {
      const actions = make("div"); const edit = make("button", "quiet") as HTMLButtonElement; edit.type = "button"; edit.dataset.connectionEditId = connection.id; text(edit, "편집");
      const remove = make("button", "danger") as HTMLButtonElement; remove.type = "button"; remove.dataset.connectionDeleteId = connection.id; text(remove, "삭제"); actions.append(edit, remove); card.append(left, actions);
    }
    list.append(card);
  }
}
function connectionEditForm(connection: Connection): HTMLFormElement {
  const form = make("form", "stack form-grid") as HTMLFormElement; form.dataset.connectionId = connection.id;
  form.append(field("이름", "name", connection.name));
  const type = make("p", "fine"); text(type, `유형: ${connection.type} (변경할 수 없음)`); form.append(type);
  if (connection.type === "vertex") {
    form.append(field("GCP Project", "project", String(connection.config.project ?? "")), field("Location", "location", String(connection.config.location ?? "global")), numberField("Context tokens", "contextTokens", String(connection.config.contextTokens ?? 1048576)));
  } else if (connection.type === "oai-compatible" || connection.type === "custom-api") {
    form.append(urlField("Endpoint", "endpoint", String(connection.config.endpoint ?? "")), numberField("Context tokens", "contextTokens", String(connection.config.contextTokens ?? "")));
  } else if (connection.type === "codex") {
    form.append(numberField("Context tokens", "contextTokens", String(connection.config.contextTokens ?? 64000)));
  }
  if (connection.type !== "mock" && connection.type !== "codex") {
    const credential = textAreaField("인증정보", "credential", "", true); const area = credential.querySelector("textarea")!; area.autocomplete = "off"; area.placeholder = "비워두면 현재 인증정보를 유지합니다."; form.append(credential);
  }
  const note = make("p", "fine wide"); text(note, "이 Connection을 공유하는 참가자는 다음 호출부터 새 설정을 사용합니다. 진행 중 호출은 기존 설정을 유지합니다.");
  const actions = make("div", "wide"); const save = make("button", "primary") as HTMLButtonElement; save.type = "submit"; text(save, "수정 저장"); const cancel = make("button", "quiet") as HTMLButtonElement; cancel.type = "button"; cancel.dataset.connectionCancel = connection.id; text(cancel, "취소"); const remove = make("button", "danger") as HTMLButtonElement; remove.type = "button"; remove.dataset.connectionDeleteId = connection.id; text(remove, "삭제"); actions.append(save, cancel, remove); form.append(note, actions); return form;
}
function codexControls(connection: Connection): HTMLElement {
  const box = make("div", "codex-controls"); box.dataset.codexId = connection.id;
  const state = make("span", "fine"); state.dataset.codexState = ""; text(state, "Codex 인증 상태 확인 중");
  const login = make("button", "quiet") as HTMLButtonElement; login.type = "button"; text(login, "ChatGPT 로그인");
  login.dataset.codexLogin = "";
  const cancel = make("button", "quiet") as HTMLButtonElement; cancel.type = "button"; text(cancel, "로그인 취소"); cancel.hidden = true;
  cancel.dataset.codexCancel = "";
  const link = make("a"); link.dataset.codexLink = ""; link.target = "_blank"; link.rel = "noopener noreferrer"; link.hidden = true; text(link, "ChatGPT 인증 화면 열기 (서버 PC에서)");
  login.addEventListener("click", () => void startCodexLogin(connection.id, login)); cancel.addEventListener("click", () => void cancelCodexLogin(connection.id, cancel)); box.append(state, login, cancel, link);
  void refreshCodexStatus(connection.id);
  return box;
}
function refreshCodexStatuses(): void { for (const box of document.querySelectorAll<HTMLElement>("[data-codex-id]")) void refreshCodexStatus(box.dataset.codexId!); }
async function refreshCodexStatus(id: string): Promise<void> {
  if (codexStatusRequests.has(id)) return; codexStatusRequests.add(id);
  try {
    const status = await api<CodexStatus>(`/api/connections/${id}/codex/status`);
    if (!status.busy) codexLoginUrls.delete(id);
    for (const box of document.querySelectorAll<HTMLElement>("[data-codex-id]")) {
      if (box.dataset.codexId !== id) continue;
      text(box.querySelector("[data-codex-state]")!, status.message ?? (status.authenticated ? "Codex 인증됨" : status.busy ? "Codex 인증 대기 중" : "Codex 로그인이 필요합니다."));
      (box.querySelector("[data-codex-login]") as HTMLButtonElement).hidden = status.authenticated || status.busy || !status.available;
      (box.querySelector("[data-codex-cancel]") as HTMLButtonElement).hidden = !status.busy;
      const link = box.querySelector("[data-codex-link]") as HTMLAnchorElement; const url = codexLoginUrls.get(id);
      link.hidden = !status.busy || !url; if (url) link.href = url; else link.removeAttribute("href");
    }
  } catch { /* The next regular management refresh retries status. */ }
  finally { codexStatusRequests.delete(id); }
}
async function startCodexLogin(id: string, button: HTMLButtonElement): Promise<void> { button.disabled = true; try { const result = await api<{ loginUrl: string }>(`/api/connections/${id}/codex/login`, { method: "POST", body: "{}" }); const url = new URL(result.loginUrl); if (url.protocol !== "https:" || !(url.hostname === "openai.com" || url.hostname.endsWith(".openai.com") || url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com"))) throw new Error("안전한 ChatGPT 로그인 주소가 아닙니다."); codexLoginUrls.set(id, url.toString()); await refreshCodexStatus(id); } catch (error) { showError(error instanceof Error ? error.message : "Codex 인증을 시작하지 못했습니다."); } finally { button.disabled = false; } }
async function cancelCodexLogin(id: string, button: HTMLButtonElement): Promise<void> { button.disabled = true; try { await api(`/api/connections/${id}/codex/cancel`, { method: "POST", body: "{}" }); codexLoginUrls.delete(id); await refreshCodexStatus(id); } catch (error) { showError(error instanceof Error ? error.message : "Codex 인증을 취소하지 못했습니다."); } finally { button.disabled = false; } }
function renderConnectionChoices(): void { if (!state) return; const select = $("participant-connection") as HTMLSelectElement; const prior = select.value; clear(select); for (const connection of state.connections) { const option = make("option") as HTMLOptionElement; option.value = connection.id; text(option, `${connection.name} (${connection.type})`); select.append(option); } if ([...select.options].some((option) => option.value === prior)) select.value = prior; configureReasoning($('participant-form') as HTMLFormElement); }
function renderLan(): void { if (!state) return; const list = $("lan-addresses"); clear(list); if (!state.lanAddresses.length) { const empty = make("span", "fine"); text(empty, "사용 가능한 LAN IPv4 주소를 찾지 못했습니다."); list.append(empty); } for (const address of state.lanAddresses) { const link = make("a") as HTMLAnchorElement; link.href = address; text(link, address); list.append(link); } }

async function openPost(id: string): Promise<void> { const epoch = roomEpoch; try { const post = await api<Post>(`/api/posts/${id}`); if (epoch !== roomEpoch) return; postDialog.dataset.postId = id; text($("dialog-post-meta"), `P${post.id} · ${post.author.displayName} · ${fmtTime(post.createdAt)}`); text($("dialog-post-title"), post.title); text($("dialog-post-body"), post.body); postDialog.showModal(); } catch (error) { showError(error instanceof Error ? error.message : "게시글을 열 수 없습니다."); } }
async function refreshOpenPost(id: string): Promise<void> { try { const post = await api<Post>(`/api/posts/${id}`); if (postDialog.open && postDialog.dataset.postId === id) { text($('dialog-post-title'), post.title); text($('dialog-post-body'), post.body); } } catch { if (postDialog.open && postDialog.dataset.postId === id) postDialog.close(); } }
function setTab(tab: string): void { activeTab = tab; for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) button.classList.toggle("active", button.dataset.tab === tab); for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) { const active = panel.id === `tab-${tab}`; panel.hidden = !active; panel.classList.toggle("active", active); } hideError(); if (tab === 'memos') invalidateDeletedMemos(); renderActive(); scrollRoomToLatest(); if (tab === 'prompts') void renderPrompts(); }
async function refresh(): Promise<void> { try { await loadState(); hideError(); } catch (error) { if (error instanceof Error && /로그인|접속 토큰|401/.test(error.message)) showLogin(); else { $("connection-state").textContent = "연결 재시도 중"; showError(error instanceof Error ? error.message : "새 정보를 가져오지 못했습니다."); } } }
function resetDeletedMemos(): void { memoContextVersion++; invalidateDeletedMemos(); deletedMemos = []; showDeletedMemos = false; deletingMemoIds.clear(); clear($('memo-list')); }
function showLogin(): void { if (refreshTimer) window.clearInterval(refreshTimer); resetConnectionEditing(); resetDeletedMemos(); manageFingerprint = ""; appView.hidden = true; loginView.hidden = false; loginToken.focus(); }
function showApp(): void { loginView.hidden = true; appView.hidden = false; scrollRoomToLatest(); if (activeTab === 'prompts') void renderPrompts(); if (refreshTimer) window.clearInterval(refreshTimer); refreshTimer = window.setInterval(() => void refresh(), 4000); }

loginForm.addEventListener("submit", async (event) => { event.preventDefault(); hideError(true); const token = loginToken.value; try { await api("/api/login", { method: "POST", body: JSON.stringify({ token }) }); loginToken.value = ""; showApp(); await refresh(); } catch (error) { loginToken.value = ""; showError(error instanceof Error ? error.message : "로그인에 실패했습니다.", true); } });
resForm.addEventListener("submit", async (event) => { event.preventDefault(); if (!resMessage.value.trim()) return; try { await api("/api/res", { method: "POST", body: JSON.stringify({ message: resMessage.value }) }); resMessage.value = ""; await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "레스 저장에 실패했습니다."); } });
$("post-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { await api("/api/posts", { method: "POST", body: JSON.stringify({ title: ( $("post-title") as HTMLInputElement).value, message: ( $("post-message") as HTMLTextAreaElement).value, body: ( $("post-body") as HTMLTextAreaElement).value }) }); form.reset(); await refresh(); setTab("board"); } catch (error) { showError(error instanceof Error ? error.message : "Big Board 저장에 실패했습니다."); } });
$("archive-thread").addEventListener("change", (event) => { archiveSearchActive = false; archiveDetail = null; ($('archive-back') as HTMLButtonElement).hidden = true; void loadThread(Number((event.target as HTMLSelectElement).value)); });
$("archive-search").addEventListener("submit", (event) => { event.preventDefault(); archiveQuery = ($('archive-query') as HTMLInputElement).value.trim(); archiveDetail = null; archiveSearchActive = Boolean(archiveQuery); ($('archive-back') as HTMLButtonElement).hidden = true; if (archiveSearchActive) void searchArchive(); else { archiveFingerprint = ''; renderArchiveThreads(); } });
$("delete-threads").addEventListener('click', async () => { const numbers = [...document.querySelectorAll<HTMLInputElement>('[data-thread-delete]:checked')].map((input) => Number(input.value)); if (!numbers.length) { showError('삭제할 종료 불판을 선택하세요.'); return; } if (!window.confirm(`${numbers.length}개 종료 불판의 원문을 삭제할까요?`)) return; try { await api('/api/threads/delete', { method: 'POST', body: JSON.stringify({ numbers }) }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : '불판을 삭제하지 못했습니다.'); } });
$("archive-back").addEventListener('click', () => { archiveDetail = null; ($('archive-back') as HTMLButtonElement).hidden = true; if (archiveSearchActive) void searchArchive(); else { archiveFingerprint = ''; renderArchiveThreads(); } });
$("participant-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { const data = new FormData(form); const modelOptions = parseOptions(String(data.get("modelOptions") ?? "{}")); const effort = String(data.get('reasoningEffort') ?? ''); const type = state?.connections.find((item) => item.id === data.get('connectionId'))?.type; delete modelOptions.reasoningEffort; delete modelOptions.thinkingLevel; if (effort.trim()) { if (type === 'vertex') modelOptions.thinkingLevel = effort; else if (type === 'codex') modelOptions.reasoningEffort = effort; } await api("/api/participants", { method: "POST", body: JSON.stringify({ displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions }) }); form.reset(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "참가자 추가에 실패했습니다."); } });
$("connection-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form); const type = String(data.get("type")); const config: Record<string, unknown> = type === "vertex" ? { project: data.get("project"), location: data.get("location") || "global", contextTokens: 1048576 } : type === "mock" ? {} : type === "codex" ? { contextTokens: Number(data.get("contextTokens") || 64000) } : { endpoint: data.get("endpoint"), contextTokens: Number(data.get("contextTokens")), jsonMode: true }; try { await api("/api/connections", { method: "POST", body: JSON.stringify({ name: data.get("name"), type, config, credential: type === "codex" ? undefined : String(data.get("credential") ?? "") || undefined }) }); form.reset(); configureConnectionForm(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "Connection 저장에 실패했습니다."); } });
$("connection-type").addEventListener("change", configureConnectionForm);
$('participant-connection').addEventListener('change', () => configureReasoning($('participant-form') as HTMLFormElement));
$("demo-add").addEventListener("click", async () => { try { const connection = await api<Connection>("/api/connections", { method: "POST", body: JSON.stringify({ name: `데모 Mock ${new Date().toLocaleTimeString("ko-KR")}`, type: "mock", config: {} }) }); await api("/api/participants", { method: "POST", body: JSON.stringify({ displayName: "데모 참가자", connectionId: connection.id, modelId: "mock-room", modelOptions: { mockAction: "wait" } }) }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "데모 추가에 실패했습니다."); } });
$("participant-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-toggle-id],[data-participant-delete-id]"); if (!button || button.disabled) return;
  if (button.dataset.participantDeleteId) {
    const id = button.dataset.participantDeleteId; const participant = state?.participants.find((item) => item.id === id); if (!participant) return;
    if (!window.confirm(`“${participant.displayName}” 참가자를 삭제할까요? 공개 대화, Private Memo, 사용량 기록은 보존됩니다.`)) return;
    void deleteParticipant(id, button); return;
  }
  const participant = state?.participants.find((item) => item.id === button.dataset.toggleId); if (participant) void updateParticipant(participant.id, { enabled: !participant.enabled });
});
$("participant-list").addEventListener("submit", (event) => { const form = event.target as HTMLFormElement; if (!form.dataset.participantId) return; event.preventDefault(); try { const data = new FormData(form); const options = parseOptions(String(data.get("modelOptions") ?? "{}")); const effort = String(data.get("reasoningEffort") ?? "").trim(); const type = state?.connections.find((item) => item.id === data.get('connectionId'))?.type; delete options.reasoningEffort; delete options.thinkingLevel; if (effort.trim()) { if (type === 'vertex') options.thinkingLevel = effort; else if (type === 'codex') options.reasoningEffort = effort; } void updateParticipant(form.dataset.participantId, { displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions: options }); } catch (error) { showError(error instanceof Error ? error.message : "설정을 확인하세요."); } });
$("connection-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-connection-edit-id],[data-connection-cancel],[data-connection-delete-id]"); if (!button || button.disabled) return;
  if (button.dataset.connectionDeleteId) {
    const id = button.dataset.connectionDeleteId; const connection = state?.connections.find((item) => item.id === id); if (!connection) return;
    if (!window.confirm(`“${connection.name}” Connection을 삭제할까요? 연결된 참가자나 진행 중 호출이 있으면 삭제할 수 없습니다.`)) return;
    void deleteConnection(id, button); return;
  }
  const id = button.dataset.connectionEditId ?? button.dataset.connectionCancel!;
  if (button.dataset.connectionCancel) { const form = button.closest("form") as HTMLFormElement | null; form?.reset(); }
  editingConnectionId = button.dataset.connectionCancel ? null : id; renderConnections();
});
$("connection-list").addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement; if (!form.dataset.connectionId) return; event.preventDefault();
  const connection = state?.connections.find((item) => item.id === form.dataset.connectionId); if (!connection) return;
  const data = new FormData(form); const config: Record<string, unknown> = connection.type === "vertex" ? { project: data.get("project"), location: data.get("location"), contextTokens: Number(data.get("contextTokens")) } : connection.type === "oai-compatible" || connection.type === "custom-api" ? { endpoint: data.get("endpoint"), contextTokens: Number(data.get("contextTokens")) } : connection.type === "codex" ? { contextTokens: Number(data.get("contextTokens")) } : {};
  void updateConnection(connection.id, { name: data.get("name"), config, credential: String(data.get("credential") ?? "") || undefined }, form);
});
messages.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-post-id]"); if (button) void openPost(button.dataset.postId!); });
$("archive-result").addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-post-id]"); if (button) void openPost(button.dataset.postId!); });
$("post-list").addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-post-id]"); if (button) void openPost(button.dataset.postId!); });
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab!)));
$("post-dialog-close").addEventListener("click", () => postDialog.close());
$("cycle-dialog-close").addEventListener("click", () => cycleDialog.close());
$("logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } finally { state = null; roomFingerprint = boardFingerprint = memoFingerprint = manageFingerprint = ""; showLogin(); } });
$("shutdown-button").addEventListener("click", async () => { if (!window.confirm("Room Server를 지금 종료할까요? 진행 중 모델 호출은 무효화되고, 이 브라우저의 Room 접근도 끊깁니다.")) return; try { await api("/api/shutdown", { method: "POST", body: "{}" }); resetConnectionEditing(); if (refreshTimer) window.clearInterval(refreshTimer); appView.hidden = true; shutdownView.hidden = false; } catch (error) { showError(error instanceof Error ? error.message : "서버 종료 요청에 실패했습니다."); } });

async function updateParticipant(id: string, patch: Record<string, unknown>): Promise<void> { try { await api(`/api/participants/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "참가자 설정을 저장하지 못했습니다."); } }
async function deleteParticipant(id: string, button: HTMLButtonElement): Promise<void> {
  if (deletingParticipantIds.has(id)) return;
  deletingParticipantIds.add(id); button.disabled = true;
  try { await api(`/api/participants/${id}`, { method: "DELETE" }); button.closest(".participant-card")?.remove(); await refresh(); }
  catch (error) { showError(error instanceof Error ? error.message : "참가자를 삭제하지 못했습니다."); }
  finally { deletingParticipantIds.delete(id); button.disabled = false; }
}
async function updateConnection(id: string, patch: Record<string, unknown>, form: HTMLFormElement): Promise<void> {
  if (form.dataset.pending) return;
  form.dataset.pending = "true";
  for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  try { await api(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); form.reset(); editingConnectionId = null; await refresh(); }
  catch (error) { showError(error instanceof Error ? error.message : "Connection 설정을 저장하지 못했습니다."); }
  finally { delete form.dataset.pending; for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false; }
}
async function deleteConnection(id: string, button: HTMLButtonElement): Promise<void> {
  if (deletingConnectionIds.has(id)) return;
  deletingConnectionIds.add(id); button.disabled = true;
  try {
    const result = await api<{ cleanupWarning: boolean }>(`/api/connections/${id}`, { method: "DELETE" });
    const card = button.closest(".connection-card");
    if (editingConnectionId === id) {
      for (const input of card?.querySelectorAll<HTMLTextAreaElement>('textarea[name="credential"]') ?? []) input.value = "";
      editingConnectionId = null;
    }
    card?.remove();
    await refresh();
    if (result.cleanupWarning) window.alert("Connection은 삭제했지만 이전 인증정보 파일을 정리하지 못했습니다.");
  } catch (error) { showError(error instanceof Error ? error.message : "Connection을 삭제하지 못했습니다."); }
  finally { deletingConnectionIds.delete(id); button.disabled = false; }
}
function record(node: HTMLElement, title: string, body: string): void { const card = make('article', 'record-card'); const heading = make('h3'); text(heading, title); const pre = make('pre'); text(pre, body); card.append(heading, pre); node.append(card); }
function corePromptProblem(template: string): string | undefined {
  if (!template.trim()) return '공통 프롬프트를 입력하세요.';
  if (template.length > 100000) return '공통 프롬프트는 100,000자 이내로 입력하세요.';
  if (template.split('{slot}').length !== 2) return '{slot}을 정확히 한 개 포함해야 합니다.';
}
function updatePromptEditor(message?: string): void {
  const loaded = savedCorePrompt !== undefined;
  const dirty = loaded && corePromptEditor.value !== savedCorePrompt;
  const conflict = loaded && latestCorePrompt !== savedCorePrompt;
  const problem = loaded ? corePromptProblem(corePromptEditor.value) : undefined;
  corePromptEditor.disabled = !loaded || promptSaving;
  ($('core-prompt-save') as HTMLButtonElement).disabled = !loaded || !dirty || conflict || Boolean(problem) || promptSaving || promptsLoading;
  ($('core-prompt-discard') as HTMLButtonElement).disabled = !loaded || (!dirty && !conflict) || promptSaving || promptsLoading;
  text($('core-prompt-status'), message ?? (!loaded ? '프롬프트를 불러오는 중입니다.' : problem ?? (conflict ? '다른 화면에서 저장된 내용이 변경되었습니다. 작성 중인 내용은 유지했습니다. 저장된 내용으로 되돌린 후 수정하세요.' : dirty ? '저장하지 않은 변경 사항이 있습니다.' : '저장된 공통 프롬프트입니다.')));
}
function applyCorePrompts(prompts: CorePromptRecord[], replaceDraft = false): void {
  const common = prompts.find((item) => item.adapter === 'all');
  if (!common || typeof common.text !== 'string') throw new Error('공통 프롬프트를 불러오지 못했습니다.');
  latestCorePrompt = common.text;
  if (replaceDraft || savedCorePrompt === undefined || corePromptEditor.value === savedCorePrompt) {
    savedCorePrompt = common.text;
    corePromptEditor.value = common.text;
  }
}
async function renderPrompts(): Promise<void> {
  if (promptsLoading || promptSaving) return;
  promptsLoading = true;
  updatePromptEditor();
  try {
    const prompts = await api<CorePromptRecord[]>('/api/prompts');
    if (activeTab !== 'prompts') return;
    applyCorePrompts(prompts);
  } catch (error) { showError(error instanceof Error ? error.message : 'Core Prompt를 불러오지 못했습니다.'); }
  finally { promptsLoading = false; updatePromptEditor(); }
}
corePromptEditor.addEventListener('input', () => updatePromptEditor());
$('core-prompt-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savedCorePrompt === undefined || promptSaving || promptsLoading) return;
  const template = corePromptEditor.value;
  const problem = corePromptProblem(template);
  if (problem) { updatePromptEditor(problem); return; }
  if (template === savedCorePrompt) return;
  promptSaving = true; hideError(); updatePromptEditor('저장 중입니다.');
  let message: string;
  try {
    const prompts = await api<CorePromptRecord[]>('/api/prompts', { method: 'PATCH', body: JSON.stringify({ template, expectedTemplate: savedCorePrompt }) });
    applyCorePrompts(prompts, true);
    message = '저장되었습니다. 다음 Cycle부터 적용됩니다.';
  } catch (error) {
    message = error instanceof Error ? error.message : '공통 프롬프트를 저장하지 못했습니다.';
    if (error instanceof ApiError && error.status === 409) {
      try { applyCorePrompts(await api<CorePromptRecord[]>('/api/prompts')); } catch { /* Keep the draft and original conflict message. */ }
    }
    showError(message);
  }
  finally { promptSaving = false; updatePromptEditor(message!); }
});
$('core-prompt-discard').addEventListener('click', async () => {
  if (promptSaving || promptsLoading) return;
  promptSaving = true; hideError(); updatePromptEditor('저장된 내용을 불러오는 중입니다.');
  let message: string;
  try { applyCorePrompts(await api<CorePromptRecord[]>('/api/prompts'), true); message = '저장된 내용으로 되돌렸습니다.'; }
  catch (error) { message = error instanceof Error ? error.message : '저장된 내용을 불러오지 못했습니다.'; showError(message); }
  finally { promptSaving = false; updatePromptEditor(message!); }
});
function renderTransport(target: HTMLElement, value: unknown, label: string): void {
  const section = make('section', 'transport-field');
  const heading = make('h3', 'transport-label'); text(heading, label); section.append(heading);
  if (typeof value === 'string') {
    let structured: unknown;
    if (/^\s*[\[{]/.test(value)) { try { structured = JSON.parse(value); } catch { /* Plain prompt text remains text. */ } }
    if (structured !== null && typeof structured === 'object') {
      const hint = make('p', 'fine'); text(hint, '문자열 안의 JSON을 펼쳐 표시'); section.append(hint);
      renderTransportFields(section, structured);
    } else {
      const content = make('pre', 'transport-text');
      text(content, value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '\t'));
      section.append(content);
    }
  } else if (value !== null && typeof value === 'object') renderTransportFields(section, value);
  else { const content = make('pre', 'transport-text'); text(content, String(value)); section.append(content); }
  target.append(section);
}
function renderTransportFields(target: HTMLElement, value: object): void {
  const entries = Object.entries(value);
  if (!entries.length) { const empty = make('pre', 'transport-text'); text(empty, Array.isArray(value) ? '[]' : '{}'); target.append(empty); return; }
  for (const [key, item] of entries) renderTransport(target, item, Array.isArray(value) ? `[${key}]` : key);
}
async function showPreview(id: string): Promise<void> {
  const epoch = roomEpoch;
  try {
    const preview = await api<{ transport: unknown; note?: string | null }>(`/api/participants/${id}/preview`);
    if (epoch !== roomEpoch) return;
    text($('cycle-dialog-title'), '실제 입력 미리보기');
    const body = $('cycle-dialog-body'); clear(body); body.classList.add('transport-preview');
    if (preview.note) { const note = make('p', 'fine'); text(note, preview.note); body.append(note); }
    renderTransport(body, preview.transport, 'Transport');
    cycleDialog.showModal();
  } catch (error) { showError(error instanceof Error ? error.message : '미리보기를 불러오지 못했습니다.'); }
}
function filterSelect(labelText: string, items: Array<{ id: string; displayName?: string | null; name?: string; deleted?: boolean }>, selected: string, change: (value: string) => void): HTMLElement {
  const label = make('label'); text(label, labelText); const select = make('select'); const all = make('option'); all.value = ''; text(all, '전체'); select.append(all);
  for (const item of items) { const option = make('option'); option.value = item.id; text(option, `${item.displayName ?? item.name ?? item.id}${item.deleted ? ' · 삭제됨' : ''}`); select.append(option); } select.value = selected; select.addEventListener('change', () => change(select.value)); label.append(select); return label;
}
function pageButtons(list: HTMLElement, hasEarlier: boolean, earlier: () => void, latest: () => void): void { const bar = make('div', 'archive-batch'); const first = make('button', 'quiet'); text(first, '최근 기록'); first.addEventListener('click', latest); const more = make('button', 'quiet'); text(more, '이전 기록'); more.disabled = !hasEarlier; more.addEventListener('click', earlier); bar.append(first, more); list.append(bar); }
async function copyText(value: string): Promise<void> { try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value); else { const area = make('textarea'); area.value = value; document.body.append(area); area.select(); const copied = document.execCommand('copy'); area.remove(); if (!copied) window.prompt('복사할 내용', value); } } catch { window.prompt('복사할 내용', value); } }
async function renderUsage(): Promise<void> {
  const sequence = ++usageRequestSequence;
  try { const query = new URLSearchParams({ limit: '100' }); if (usageParticipant) query.set('participantId', usageParticipant); if (usageConnection) query.set('connectionId', usageConnection); if (usageBefore) query.set('beforeId', String(usageBefore)); const result = await api<{ records: Array<any>; participants: any[]; connections: any[] }>(`/api/usage?${query}`); if (sequence !== usageRequestSequence || activeTab !== 'usage') return; const list = $('usage-list'); clear(list); const bar = make('div', 'archive-controls'); bar.append(filterSelect('참가자', result.participants, usageParticipant, (value) => { usageParticipant = value; usageBefore = undefined; void renderUsage(); }), filterSelect('Connection', result.connections, usageConnection, (value) => { usageConnection = value; usageBefore = undefined; void renderUsage(); })); list.append(bar);
    for (const group of [['참가자 누계', result.participants], ['Connection 누계', result.connections]] as const) for (const item of group[1]) record(list, `${group[0]} · ${item.displayName ?? item.id}${item.type ? ` (${item.type})` : ''}${item.deleted ? ' · 삭제됨' : ''}${item.simulated ? ' · Mock 모의값 포함' : ''}`, `호출 ${item.calls} · 입력 ${item.inputTokens ?? '-'} / 출력 ${item.outputTokens ?? '-'} / reasoning ${item.reasoningTokens ?? '-'} / cache ${item.cachedInputTokens ?? '-'}`);
    for (const usage of result.records) { const card = make('article', 'record-card'); const heading = make('h3'); text(heading, `${fmtTime(usage.createdAt)} · ${usage.participantName ?? usage.participantId}${usage.participantDeleted ? ' · 참가자 삭제됨' : ''} · ${usage.connectionName ?? '-'} (${usage.connectionType ?? '-'})${usage.connectionDeleted ? ' · Connection 삭제됨' : ''}${usage.simulated ? ' · Mock 모의값' : ''}`); const pre = make('pre'); text(pre, `request ${usage.requestId ?? '-'}\n입력 ${usage.inputTokens ?? '-'} / 출력 ${usage.outputTokens ?? '-'} / reasoning ${usage.reasoningTokens ?? '-'} / cache ${usage.cachedInputTokens ?? '-'}\n${usage.providerUsage ? JSON.stringify(usage.providerUsage, null, 2) : 'provider usage 미제공'}`); const cycle = make('button', 'quiet'); text(cycle, `Cycle ${usage.cycleId}`); cycle.addEventListener('click', () => void showCycle(usage.cycleId)); card.append(heading, pre, cycle); list.append(card); }
    if (!result.records.length) record(list, 'Usage', '표시할 호출 기록이 없습니다.'); pageButtons(list, result.records.length === 100, () => { usageBefore = result.records.at(-1)?.id; void renderUsage(); }, () => { usageBefore = undefined; void renderUsage(); });
  } catch (error) { showError(error instanceof Error ? error.message : 'Usage를 불러오지 못했습니다.'); }
}
async function showCycle(id: string): Promise<void> { const epoch = roomEpoch; try { const data = await api<any>(`/api/cycles/${id}`); text($('cycle-dialog-title'), 'Cycle 상세'); const body = $('cycle-dialog-body'); clear(body); body.classList.remove('transport-preview'); const connection = data.connection ? `${data.connection.displayName ?? data.connection.id}${data.connection.type ? ` (${data.connection.type})` : ''}${data.connection.deleted ? ' · 삭제됨' : ''}` : '-'; record(body, `${data.cycle.participantName ?? data.cycle.participantId}${data.cycle.participantDeleted ? ' · 참가자 삭제됨' : ''} · ${data.cycle.status} · ${fmtTime(data.cycle.startedAt)}`, JSON.stringify({ connection, result: data.result, events: data.events, usage: data.usage, error: data.cycle.error }, null, 2)); const errors = await api<any[]>(`/api/errors?cycleId=${encodeURIComponent(id)}`); if (epoch !== roomEpoch) return; for (const error of errors) { const button = make('button', 'quiet'); text(button, `Errors #${error.id} 보기`); button.addEventListener('click', () => { cycleDialog.close(); selectedError = error.id; errorBefore = undefined; setTab('errors'); }); body.append(button); } cycleDialog.showModal(); } catch (error) { showError(error instanceof Error ? error.message : 'Cycle 상세를 불러오지 못했습니다.'); } }
async function renderCycles(): Promise<void> {
  const sequence = ++cycleRequestSequence;
  try { const query = new URLSearchParams({ limit: '100' }); if (cycleParticipant) query.set('participantId', cycleParticipant); if (cycleBefore) query.set('beforeStartedAt', String(cycleBefore)); const cycles = await api<Array<any>>(`/api/cycles?${query}`); if (sequence !== cycleRequestSequence || activeTab !== 'cycles') return; const list = $('cycle-list'); clear(list); const names = new Map((state?.participants ?? []).map((item) => [item.id, item.displayName])); const cycleByParticipant = new Map(cycles.map((cycle) => [cycle.participantId, cycle])); const items = [...new Set([...names.keys(), ...cycles.map((cycle) => cycle.participantId)])].map((id) => ({ id, displayName: names.get(id) ?? cycleByParticipant.get(id)?.participantName ?? cycleByParticipant.get(id)?.participantId ?? id, deleted: cycleByParticipant.get(id)?.participantDeleted === true })); list.append(filterSelect('참가자', items, cycleParticipant, (value) => { cycleParticipant = value; cycleBefore = undefined; void renderCycles(); }));
    for (const participant of state?.participants ?? []) { if (cycleParticipant && participant.id !== cycleParticipant) continue; const runtime = participant.runtime as any; const cycleState = participant.cycleState; record(list, `현재 · ${participant.displayName} · ${participant.enabled ? 'ON' : 'OFF'} · ${runtime.status === 'calling' ? 'generating' : runtime.nextPollAt ? 'polling' : runtime.status}`, `진행 시작 ${cycleState?.activeStartedAt ? fmtTime(cycleState.activeStartedAt) : '-'}\n마지막 완료 ${cycleState?.lastCompletedAt ? fmtTime(cycleState.lastCompletedAt) : '-'} · 마지막 Action ${cycleState?.lastAction?.toUpperCase() ?? '-'}\nObserved ${runtime.observed ? `T${cycleState?.observedThreadNumber ?? '?'}-R${runtime.observed.resNumber}` : '-'} · 다음 ${secondsUntil(runtime.nextPollAt)}`); }
    for (const cycle of cycles) { const card = make('article', 'record-card'); const heading = make('h3'); const duration = cycle.completedAt != null ? `${((cycle.completedAt - cycle.startedAt) / 1000).toFixed(1)}초` : '진행 중'; const connection = cycle.connection ? `${cycle.connection.displayName ?? cycle.connection.id}${cycle.connection.deleted ? ' · Connection 삭제됨' : ''}` : '-'; text(heading, `${names.get(cycle.participantId) ?? cycle.participantName ?? cycle.participantId}${cycle.participantDeleted ? ' · 참가자 삭제됨' : ''} · ${cycle.status} · ${cycle.finalAction?.toUpperCase() ?? '-'} · ${duration}`); const meta = make('p', 'fine'); text(meta, `Connection ${connection} · 시작 ${fmtTime(cycle.startedAt)} · 종료 ${cycle.completedAt != null ? fmtTime(cycle.completedAt) : '-'}${cycle.result?.res != null ? ` · T${cycle.result.thread}-R${cycle.result.res}` : ''}${cycle.result?.postId != null ? ` · P${cycle.result.postId}` : ''}`); const detail = make('button', 'quiet'); text(detail, '읽기 Action / Usage 상세'); detail.addEventListener('click', () => void showCycle(cycle.id)); card.append(heading, meta, detail); if (cycle.errorId) { const error = make('button', 'quiet'); text(error, `Errors #${cycle.errorId}`); error.addEventListener('click', () => { selectedError = cycle.errorId; errorBefore = undefined; setTab('errors'); }); card.append(error); } list.append(card); }
    if (!cycles.length) record(list, 'Cycle 이력', '기록이 없습니다.'); pageButtons(list, cycles.length === 100, () => { cycleBefore = cycles.at(-1)?.startedAt; void renderCycles(); }, () => { cycleBefore = undefined; void renderCycles(); });
  } catch (error) { showError(error instanceof Error ? error.message : 'Cycle 기록을 불러오지 못했습니다.'); }
}
async function renderErrors(): Promise<void> {
  const sequence = ++errorRequestSequence;
  try { const errors = await api<Array<any>>(`/api/errors?limit=100${errorBefore ? `&beforeId=${errorBefore}` : ''}`); if (selectedError && !errors.some((error) => error.id === selectedError)) { const found = await api<any>(`/api/errors/${selectedError}`).catch(() => null); if (found) errors.unshift(found); } if (sequence !== errorRequestSequence || activeTab !== 'errors') return; const list = $('error-list'); clear(list);
    for (const item of errors) { const card = make('article', 'record-card'); const title = make('h3'); text(title, `${fmtTime(item.createdAt)} · ${item.source} · #${item.id}`); const pre = make('pre'); const detail = `${item.message}\nparticipant ${item.participantId ?? '-'} · connection ${item.connectionId ?? '-'} · cycle ${item.cycleId ?? '-'}\nHTTP ${item.httpStatus ?? '-'} · provider ${item.providerCode ?? '-'}\n${item.details ? JSON.stringify(item.details, null, 2) : ''}`; text(pre, detail); const copy = make('button', 'quiet'); text(copy, '복사'); copy.addEventListener('click', () => void copyText(detail)); card.append(title, pre, copy); if (item.cycleId) { const cycle = make('button', 'quiet'); text(cycle, 'Cycle 상세'); cycle.addEventListener('click', () => void showCycle(item.cycleId)); card.append(cycle); } list.append(card); if (item.id === selectedError) { card.classList.add('highlight'); setTimeout(() => card.scrollIntoView({ block: 'center' }), 0); selectedError = undefined; } }
    if (!errors.length) record(list, 'Errors', '기록된 오류가 없습니다.'); pageButtons(list, errors.length >= 100, () => { errorBefore = errors.at(-1)?.id; void renderErrors(); }, () => { errorBefore = undefined; void renderErrors(); });
  } catch (error) { showError(error instanceof Error ? error.message : '오류 기록을 불러오지 못했습니다.'); }
}
$("force-rollover").addEventListener('click', async () => { if (!window.confirm('현재 불판을 종료하고 새 불판을 만들까요?')) return; try { await api('/api/threads/rollover', { method: 'POST', body: '{}' }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : '불판을 갈지 못했습니다.'); } });
$("hard-reset").addEventListener('click', async () => { if (($('hard-reset-confirm') as HTMLInputElement).value !== 'HARD RESET') { showError('확인 문자열 HARD RESET을 입력하세요.'); return; } try { await api('/api/reset', { method: 'POST', body: JSON.stringify({ confirmation: 'HARD RESET' }) }); (document.getElementById('hard-reset-confirm') as HTMLInputElement).value = ''; await refresh(); } catch (error) { showError(error instanceof Error ? error.message : 'Hard Reset에 실패했습니다.'); } });
$("clear-errors").addEventListener('click', async () => { if (!window.confirm('오류 기록을 모두 비울까요?')) return; try { await api('/api/errors', { method: 'DELETE' }); errorBefore = selectedError = undefined; await renderErrors(); } catch (error) { showError(error instanceof Error ? error.message : '오류 기록을 비우지 못했습니다.'); } });
function clearConnectionSecrets(): void { for (const input of document.querySelectorAll<HTMLTextAreaElement>('textarea[name="credential"]')) input.value = ""; }
function resetConnectionEditing(): void { clearConnectionSecrets(); codexLoginUrls.clear(); editingConnectionId = null; clear($("connection-list")); }
function parseOptions(value: string): Record<string, unknown> { let result: unknown; try { result = JSON.parse(value); } catch { throw new Error('모델 옵션 JSON 형식을 확인하세요.'); } if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("모델 옵션은 JSON object여야 합니다."); return result as Record<string, unknown>; }
function configureConnectionForm(): void { const form = $("connection-form") as HTMLFormElement; const type = ( $("connection-type") as HTMLSelectElement).value; for (const element of form.querySelectorAll<HTMLElement>("[data-vertex]")) element.hidden = type !== "vertex"; for (const element of form.querySelectorAll<HTMLElement>("[data-endpoint]")) element.hidden = !(type === "oai-compatible" || type === "custom-api"); for (const element of form.querySelectorAll<HTMLElement>("[data-context]")) element.hidden = !(type === "oai-compatible" || type === "custom-api" || type === "codex"); for (const element of form.querySelectorAll<HTMLElement>("[data-codex]")) element.hidden = type !== "codex"; const credential = form.querySelector<HTMLElement>("[data-credential]")!; credential.hidden = type === "mock" || type === "codex"; const input = form.querySelector<HTMLTextAreaElement>("[name=credential]")!; input.placeholder = type === "vertex" ? "서비스 계정 JSON" : "API key (서버가 보호 저장소에 보관)"; }

configureConnectionForm(); void loadState().then(showApp).catch(() => showLogin());

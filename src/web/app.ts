type Author = { displayName: string };
type Message = { id: number; threadId: string; threadNumber: number; number: number; author: Author; body: string; postId: number | null };
type Thread = { id: string; number: number; status: "open" | "closed"; resCount: number };
type PostMeta = { id: number; author: Author; title: string; createdAt: number };
type Post = PostMeta & { body: string };
type Connection = { id: string; name: string; type: string; config: Record<string, unknown>; hasCredential: boolean };
type CodexStatus = { available: boolean; authenticated: boolean; busy: boolean; message?: string };
type Participant = { id: string; displayName: string; enabled: boolean; connectionId: string | null; modelId: string; modelOptions: Record<string, unknown>; systemPrompt: string; runtime: { status: string; nextPollAt: number | null; lastError: string | null } };
type ParticipantMemo = { participantId: string; displayName: string; privateMemo: string; updatedAt: number; deletedAt: number | null };
type State = { room: { name: string }; thread: Thread; messages: Message[]; participants: Participant[]; participantMemos: ParticipantMemo[]; connections: Connection[]; posts: PostMeta[]; threads: Thread[]; usage: { calls: number; inputTokens: number; outputTokens: number }; limits: { messageTokens: number }; lanAddresses: string[] };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const loginView = $("login-view"), appView = $("app-view"), shutdownView = $("shutdown-view");
const loginForm = $("login-form") as HTMLFormElement, loginToken = $("login-token") as HTMLInputElement;
const messages = $("messages"), roomName = $("room-name"), threadTitle = $("thread-title"), threadCount = $("thread-count"), appError = $("app-error"), loginError = $("login-error");
const resForm = $("res-form") as HTMLFormElement, resMessage = $("res-message") as HTMLTextAreaElement;
const postDialog = $("post-dialog") as HTMLDialogElement;
let state: State | null = null;
let activeTab = "room";
let refreshTimer: number | undefined;
let roomFingerprint = "", boardFingerprint = "", memoFingerprint = "", manageFingerprint = "";
let editingConnectionId: string | null = null;
const deletingConnectionIds = new Set<string>();
const deletingParticipantIds = new Set<string>();
const codexLoginUrls = new Map<string, string>();
const codexStatusRequests = new Set<string>();

function clear(node: Element): void { while (node.firstChild) node.removeChild(node.firstChild); }
function text(node: Node, value: unknown): void { node.textContent = String(value ?? ""); }
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (className) node.className = className; return node; }
function showError(message: string, login = false): void { const target = login ? loginError : appError; text(target, message); target.hidden = false; }
function hideError(login = false): void { (login ? loginError : appError).hidden = true; }
function fmtTime(value: number): string { return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function secondsUntil(value: number | null): string { if (!value) return "예약 없음"; const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000)); return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 후 확인` : "곧 확인"; }

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers); if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : "요청에 실패했습니다.");
  return payload as T;
}

async function loadState(): Promise<void> {
  const next = await api<State>("/api/state");
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
}

function renderRoom(): void {
  if (!state) return;
  threadTitle.textContent = `T${state.thread.number} · 현재 불판`;
  threadCount.textContent = `${state.thread.resCount} / 1000`;
  const fingerprint = state.thread.id + state.messages.map((item) => `${item.id}:${item.body}:${item.postId}`).join("|");
  if (fingerprint === roomFingerprint) return;
  const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  roomFingerprint = fingerprint; clear(messages);
  for (const message of state.messages) messages.append(createMessage(message));
  if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
}

function createMessage(message: Message): HTMLElement {
  const row = make("article", "message"); const head = make("div", "message-head");
  const author = make("span", "message-author"); text(author, message.author.displayName);
  const no = make("span", "message-no"); text(no, `T${message.threadNumber} · R${message.number}`); head.append(author, no);
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
  for (const post of state.posts) { const card = make("article", "post-card"); const info = make("div"); const title = make("h3"); text(title, post.title); const meta = make("p", "fine"); text(meta, `P${post.id} · ${post.author.displayName} · ${fmtTime(post.createdAt)}`); info.append(title, meta); const open = make("button"); open.type = "button"; open.dataset.postId = String(post.id); text(open, "본문 열기"); card.append(info, open); list.append(card); }
}

function renderArchiveThreads(): void {
  if (!state) return;
  const select = $("archive-thread") as HTMLSelectElement; const previous = select.value; clear(select);
  for (const thread of state.threads) { const option = make("option") as HTMLOptionElement; option.value = String(thread.number); text(option, `T${thread.number} · ${thread.resCount}레스${thread.status === "open" ? " (현재)" : ""}`); select.append(option); }
  select.value = previous || String(state.thread.number);
  void loadThread(Number(select.value));
}

async function loadThread(number: number): Promise<void> {
  try { const payload = await api<{ thread: Thread; messages: Message[] }>(`/api/threads/${number}`); renderArchiveMessages(payload.messages, `T${payload.thread.number} 원문`); } catch (error) { showError(error instanceof Error ? error.message : "Archive를 열 수 없습니다."); }
}
function renderArchiveMessages(items: Message[], title: string): void { const target = $("archive-result"); clear(target); const heading = make("p", "fine"); text(heading, title); target.append(heading); for (const item of items) target.append(createMessage(item)); }

function renderMemos(): void {
  if (!state) return;
  const fingerprint = JSON.stringify(state.participantMemos); if (fingerprint === memoFingerprint) return;
  memoFingerprint = fingerprint; const list = $("memo-list"); clear(list);
  if (!state.participantMemos.length) { const empty = make("p", "muted"); text(empty, "표시할 Private Memo가 없습니다."); list.append(empty); return; }
  for (const memo of state.participantMemos) {
    const card = make("article", "memo-card"); const name = make("h3"); text(name, memo.displayName);
    const meta = make("p", "fine"); text(meta, memo.deletedAt === null ? `현재 참가자 · 최종 갱신 ${fmtTime(memo.updatedAt)}` : `삭제됨 · 삭제 ${fmtTime(memo.deletedAt)}`);
    const body = make("div", `memo-body${memo.privateMemo ? "" : " muted"}`); text(body, memo.privateMemo || "(비어 있음)"); card.append(name, meta, body); list.append(card);
  }
}

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
    for (const label of [participant.modelId, participant.runtime.status, participant.runtime.lastError ? `오류: ${participant.runtime.lastError}` : "오류 없음"]) { const span = make("span"); text(span, label); meta.append(span); }
    const schedule = make("span", "participant-meta countdown"); schedule.dataset.participantId = participant.id; text(schedule, secondsUntil(participant.runtime.nextPollAt)); info.append(name, meta, schedule);
    const actions = make("div"); const toggle = make("button", `switch${participant.enabled ? "" : " off"}`); toggle.type = "button"; toggle.dataset.toggleId = participant.id; text(toggle, participant.enabled ? "ON · 다음 확인" : "OFF · 멈춤"); const remove = make("button", "danger") as HTMLButtonElement; remove.type = "button"; remove.dataset.participantDeleteId = participant.id; text(remove, "삭제"); actions.append(toggle, remove); card.append(info, actions);
    const details = make("details"); const summary = make("summary"); text(summary, "참가자 설정"); details.append(summary, participantEditForm(participant)); card.append(details); list.append(card);
  }
}
function participantEditForm(participant: Participant): HTMLFormElement {
  const form = make("form", "stack form-grid") as HTMLFormElement; form.dataset.participantId = participant.id;
  form.append(field("표시 이름", "displayName", participant.displayName), selectField("Connection", "connectionId", state?.connections ?? [], participant.connectionId), field("모델 ID", "modelId", participant.modelId), textAreaField("모델 옵션 JSON", "modelOptions", JSON.stringify(participant.modelOptions)), textAreaField("System Prompt", "systemPrompt", participant.systemPrompt, true));
  const button = make("button", "primary") as HTMLButtonElement; button.type = "submit"; text(button, "참가자 설정 저장"); form.append(button); return form;
}
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
function renderConnectionChoices(): void { if (!state) return; const select = $("participant-connection") as HTMLSelectElement; const prior = select.value; clear(select); for (const connection of state.connections) { const option = make("option") as HTMLOptionElement; option.value = connection.id; text(option, `${connection.name} (${connection.type})`); select.append(option); } select.value = prior; }
function renderLan(): void { if (!state) return; const list = $("lan-addresses"); clear(list); if (!state.lanAddresses.length) { const empty = make("span", "fine"); text(empty, "사용 가능한 LAN IPv4 주소를 찾지 못했습니다."); list.append(empty); } for (const address of state.lanAddresses) { const link = make("a") as HTMLAnchorElement; link.href = address; text(link, address); list.append(link); } }

async function openPost(id: string): Promise<void> { try { const post = await api<Post>(`/api/posts/${id}`); text($("dialog-post-meta"), `P${post.id} · ${post.author.displayName} · ${fmtTime(post.createdAt)}`); text($("dialog-post-title"), post.title); text($("dialog-post-body"), post.body); postDialog.showModal(); } catch (error) { showError(error instanceof Error ? error.message : "게시글을 열 수 없습니다."); } }
function setTab(tab: string): void { activeTab = tab; for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) button.classList.toggle("active", button.dataset.tab === tab); for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) { const active = panel.id === `tab-${tab}`; panel.hidden = !active; panel.classList.toggle("active", active); } hideError(); renderActive(); }
async function refresh(): Promise<void> { try { await loadState(); hideError(); } catch (error) { if (error instanceof Error && /로그인|접속 토큰|401/.test(error.message)) showLogin(); else { $("connection-state").textContent = "연결 재시도 중"; showError(error instanceof Error ? error.message : "새 정보를 가져오지 못했습니다."); } } }
function showLogin(): void { if (refreshTimer) window.clearInterval(refreshTimer); resetConnectionEditing(); manageFingerprint = ""; appView.hidden = true; loginView.hidden = false; loginToken.focus(); }
function showApp(): void { loginView.hidden = true; appView.hidden = false; if (refreshTimer) window.clearInterval(refreshTimer); refreshTimer = window.setInterval(() => void refresh(), 4000); }

loginForm.addEventListener("submit", async (event) => { event.preventDefault(); hideError(true); const token = loginToken.value; try { await api("/api/login", { method: "POST", body: JSON.stringify({ token }) }); loginToken.value = ""; showApp(); await refresh(); } catch (error) { loginToken.value = ""; showError(error instanceof Error ? error.message : "로그인에 실패했습니다.", true); } });
resForm.addEventListener("submit", async (event) => { event.preventDefault(); if (!resMessage.value.trim()) return; try { await api("/api/res", { method: "POST", body: JSON.stringify({ message: resMessage.value }) }); resMessage.value = ""; await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "레스 저장에 실패했습니다."); } });
$("post-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { await api("/api/posts", { method: "POST", body: JSON.stringify({ title: ( $("post-title") as HTMLInputElement).value, message: ( $("post-message") as HTMLTextAreaElement).value, body: ( $("post-body") as HTMLTextAreaElement).value }) }); form.reset(); await refresh(); setTab("board"); } catch (error) { showError(error instanceof Error ? error.message : "Big Board 저장에 실패했습니다."); } });
$("archive-thread").addEventListener("change", (event) => void loadThread(Number((event.target as HTMLSelectElement).value)));
$("archive-search").addEventListener("submit", async (event) => { event.preventDefault(); const query = ($("archive-query") as HTMLInputElement).value.trim(); if (!query) { void loadThread(Number(($("archive-thread") as HTMLSelectElement).value)); return; } try { const found = await api<Message[]>(`/api/archive?q=${encodeURIComponent(query)}`); renderArchiveMessages(found, `“${query}” 검색 결과`); } catch (error) { showError(error instanceof Error ? error.message : "검색에 실패했습니다."); } });
$("participant-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { const data = new FormData(form); await api("/api/participants", { method: "POST", body: JSON.stringify({ displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions: parseOptions(String(data.get("modelOptions") ?? "{}")) }) }); form.reset(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "참가자 추가에 실패했습니다."); } });
$("connection-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form); const type = String(data.get("type")); const config: Record<string, unknown> = type === "vertex" ? { project: data.get("project"), location: data.get("location") || "global", contextTokens: 1048576 } : type === "mock" ? {} : type === "codex" ? { contextTokens: Number(data.get("contextTokens") || 64000) } : { endpoint: data.get("endpoint"), contextTokens: Number(data.get("contextTokens")), jsonMode: true }; try { await api("/api/connections", { method: "POST", body: JSON.stringify({ name: data.get("name"), type, config, credential: type === "codex" ? undefined : String(data.get("credential") ?? "") || undefined }) }); form.reset(); configureConnectionForm(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "Connection 저장에 실패했습니다."); } });
$("connection-type").addEventListener("change", configureConnectionForm);
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
$("participant-list").addEventListener("submit", (event) => { const form = event.target as HTMLFormElement; if (!form.dataset.participantId) return; event.preventDefault(); try { const data = new FormData(form); void updateParticipant(form.dataset.participantId, { displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions: parseOptions(String(data.get("modelOptions") ?? "{}")) }); } catch (error) { showError(error instanceof Error ? error.message : "설정을 확인하세요."); } });
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
function clearConnectionSecrets(): void { for (const input of document.querySelectorAll<HTMLTextAreaElement>('textarea[name="credential"]')) input.value = ""; }
function resetConnectionEditing(): void { clearConnectionSecrets(); codexLoginUrls.clear(); editingConnectionId = null; clear($("connection-list")); }
function parseOptions(value: string): Record<string, unknown> { const result: unknown = JSON.parse(value); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("모델 옵션은 JSON object여야 합니다."); return result as Record<string, unknown>; }
function configureConnectionForm(): void { const form = $("connection-form") as HTMLFormElement; const type = ( $("connection-type") as HTMLSelectElement).value; for (const element of form.querySelectorAll<HTMLElement>("[data-vertex]")) element.hidden = type !== "vertex"; for (const element of form.querySelectorAll<HTMLElement>("[data-endpoint]")) element.hidden = !(type === "oai-compatible" || type === "custom-api"); for (const element of form.querySelectorAll<HTMLElement>("[data-context]")) element.hidden = !(type === "oai-compatible" || type === "custom-api" || type === "codex"); for (const element of form.querySelectorAll<HTMLElement>("[data-codex]")) element.hidden = type !== "codex"; const credential = form.querySelector<HTMLElement>("[data-credential]")!; credential.hidden = type === "mock" || type === "codex"; const input = form.querySelector<HTMLTextAreaElement>("[name=credential]")!; input.placeholder = type === "vertex" ? "서비스 계정 JSON" : "API key (서버가 보호 저장소에 보관)"; }

configureConnectionForm(); void loadState().then(showApp).catch(() => showLogin());

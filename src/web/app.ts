type Author = { displayName: string };
type Message = { id: number; threadId: string; threadNumber: number; number: number; author: Author; body: string; postId: number | null };
type Thread = { id: string; number: number; status: "open" | "closed"; resCount: number };
type PostMeta = { id: number; author: Author; title: string; createdAt: number };
type Post = PostMeta & { body: string };
type Connection = { id: string; name: string; type: string; config: Record<string, unknown>; hasCredential: boolean };
type Participant = { id: string; displayName: string; enabled: boolean; connectionId: string | null; modelId: string; modelOptions: Record<string, unknown>; systemPrompt: string; privateMemo: string; runtime: { status: string; nextPollAt: number | null; lastError: string | null } };
type State = { room: { name: string }; thread: Thread; messages: Message[]; participants: Participant[]; connections: Connection[]; posts: PostMeta[]; threads: Thread[]; usage: { calls: number; inputTokens: number; outputTokens: number }; limits: { messageTokens: number }; lanAddresses: string[] };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const loginView = $("login-view"), appView = $("app-view"), shutdownView = $("shutdown-view");
const loginForm = $("login-form") as HTMLFormElement, loginToken = $("login-token") as HTMLInputElement;
const messages = $("messages"), roomName = $("room-name"), threadTitle = $("thread-title"), threadCount = $("thread-count"), appError = $("app-error"), loginError = $("login-error");
const resForm = $("res-form") as HTMLFormElement, resMessage = $("res-message") as HTMLTextAreaElement;
const postDialog = $("post-dialog") as HTMLDialogElement;
let state: State | null = null;
let activeTab = "room";
let refreshTimer: number | undefined;
let roomFingerprint = "", boardFingerprint = "", manageFingerprint = "";

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

function renderManagement(): void {
  if (!state) return;
  const fingerprint = JSON.stringify({ participants: state.participants.map((p) => [p.id, p.displayName, p.enabled, p.connectionId, p.modelId, p.privateMemo, p.runtime.status, p.runtime.lastError]), connections: state.connections, lan: state.lanAddresses });
  if (fingerprint === manageFingerprint) { refreshCountdowns(); return; }
  manageFingerprint = fingerprint; renderParticipants(); renderConnections(); renderConnectionChoices(); renderLan();
}
function renderParticipants(): void {
  if (!state) return; const list = $("participant-list"); clear(list);
  if (!state.participants.length) { const empty = make("p", "muted"); text(empty, "참가자가 없습니다. Connection을 만든 뒤 추가하세요."); list.append(empty); return; }
  for (const participant of state.participants) {
    const card = make("article", "participant-card"); const info = make("div"); const name = make("h3"); text(name, participant.displayName); const meta = make("div", "participant-meta");
    for (const label of [participant.modelId, participant.runtime.status, participant.runtime.lastError ? `오류: ${participant.runtime.lastError}` : "오류 없음"]) { const span = make("span"); text(span, label); meta.append(span); }
    const schedule = make("span", "participant-meta countdown"); schedule.dataset.participantId = participant.id; text(schedule, secondsUntil(participant.runtime.nextPollAt)); info.append(name, meta, schedule);
    const toggle = make("button", `switch${participant.enabled ? "" : " off"}`); toggle.type = "button"; toggle.dataset.toggleId = participant.id; text(toggle, participant.enabled ? "ON · 다음 확인" : "OFF · 멈춤"); card.append(info, toggle);
    const details = make("details"); const summary = make("summary"); text(summary, "설정과 Private Memo"); details.append(summary);
    const memo = make("p", "fine"); text(memo, `Private Memo: ${participant.privateMemo || "(비어 있음)"}`); details.append(memo, participantEditForm(participant)); card.append(details); list.append(card);
  }
}
function participantEditForm(participant: Participant): HTMLFormElement {
  const form = make("form", "stack form-grid") as HTMLFormElement; form.dataset.participantId = participant.id;
  form.append(field("표시 이름", "displayName", participant.displayName), selectField("Connection", "connectionId", state?.connections ?? [], participant.connectionId), field("모델 ID", "modelId", participant.modelId), textAreaField("모델 옵션 JSON", "modelOptions", JSON.stringify(participant.modelOptions)), textAreaField("System Prompt", "systemPrompt", participant.systemPrompt, true));
  const button = make("button", "primary") as HTMLButtonElement; button.type = "submit"; text(button, "참가자 설정 저장"); form.append(button); return form;
}
function field(labelText: string, name: string, value: string): HTMLLabelElement { const label = make("label"); text(label, labelText); const input = make("input") as HTMLInputElement; input.name = name; input.value = value; label.append(input); return label; }
function textAreaField(labelText: string, name: string, value: string, wide = false): HTMLLabelElement { const label = make("label", wide ? "wide" : ""); text(label, labelText); const area = make("textarea") as HTMLTextAreaElement; area.name = name; area.rows = name === "systemPrompt" ? 4 : 3; area.value = value; label.append(area); return label; }
function selectField(labelText: string, name: string, items: Connection[], selected: string | null): HTMLLabelElement { const label = make("label"); text(label, labelText); const select = make("select") as HTMLSelectElement; select.name = name; for (const item of items) { const option = make("option") as HTMLOptionElement; option.value = item.id; option.selected = item.id === selected; text(option, item.name); select.append(option); } label.append(select); return label; }
function refreshCountdowns(): void { if (!state) return; for (const node of document.querySelectorAll<HTMLElement>(".countdown")) { const participant = state.participants.find((item) => item.id === node.dataset.participantId); if (participant) text(node, secondsUntil(participant.runtime.nextPollAt)); } }
function renderConnections(): void { if (!state) return; const list = $("connection-list"); clear(list); for (const connection of state.connections) { const card = make("article", "connection-card"); const left = make("div"); const title = make("strong"); text(title, connection.name); const details = make("p"); text(details, `${connection.type} · ${connection.hasCredential ? "인증정보 연결됨" : "인증정보 없음"} · context ${String(connection.config.contextTokens ?? "기본")}`); left.append(title, details); card.append(left); list.append(card); } }
function renderConnectionChoices(): void { if (!state) return; const select = $("participant-connection") as HTMLSelectElement; const prior = select.value; clear(select); for (const connection of state.connections) { const option = make("option") as HTMLOptionElement; option.value = connection.id; text(option, `${connection.name} (${connection.type})`); select.append(option); } select.value = prior; }
function renderLan(): void { if (!state) return; const list = $("lan-addresses"); clear(list); if (!state.lanAddresses.length) { const empty = make("span", "fine"); text(empty, "사용 가능한 LAN IPv4 주소를 찾지 못했습니다."); list.append(empty); } for (const address of state.lanAddresses) { const link = make("a") as HTMLAnchorElement; link.href = address; text(link, address); list.append(link); } }

async function openPost(id: string): Promise<void> { try { const post = await api<Post>(`/api/posts/${id}`); text($("dialog-post-meta"), `P${post.id} · ${post.author.displayName} · ${fmtTime(post.createdAt)}`); text($("dialog-post-title"), post.title); text($("dialog-post-body"), post.body); postDialog.showModal(); } catch (error) { showError(error instanceof Error ? error.message : "게시글을 열 수 없습니다."); } }
function setTab(tab: string): void { activeTab = tab; for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) button.classList.toggle("active", button.dataset.tab === tab); for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) { const active = panel.id === `tab-${tab}`; panel.hidden = !active; panel.classList.toggle("active", active); } hideError(); renderActive(); }
async function refresh(): Promise<void> { try { await loadState(); hideError(); } catch (error) { if (error instanceof Error && /로그인|접속 토큰|401/.test(error.message)) showLogin(); else { $("connection-state").textContent = "연결 재시도 중"; showError(error instanceof Error ? error.message : "새 정보를 가져오지 못했습니다."); } } }
function showLogin(): void { if (refreshTimer) window.clearInterval(refreshTimer); appView.hidden = true; loginView.hidden = false; loginToken.focus(); }
function showApp(): void { loginView.hidden = true; appView.hidden = false; if (refreshTimer) window.clearInterval(refreshTimer); refreshTimer = window.setInterval(() => void refresh(), 4000); }

loginForm.addEventListener("submit", async (event) => { event.preventDefault(); hideError(true); const token = loginToken.value; try { await api("/api/login", { method: "POST", body: JSON.stringify({ token }) }); loginToken.value = ""; showApp(); await refresh(); } catch (error) { loginToken.value = ""; showError(error instanceof Error ? error.message : "로그인에 실패했습니다.", true); } });
resForm.addEventListener("submit", async (event) => { event.preventDefault(); if (!resMessage.value.trim()) return; try { await api("/api/res", { method: "POST", body: JSON.stringify({ message: resMessage.value }) }); resMessage.value = ""; await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "레스 저장에 실패했습니다."); } });
$("post-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { await api("/api/posts", { method: "POST", body: JSON.stringify({ title: ( $("post-title") as HTMLInputElement).value, message: ( $("post-message") as HTMLTextAreaElement).value, body: ( $("post-body") as HTMLTextAreaElement).value }) }); form.reset(); await refresh(); setTab("board"); } catch (error) { showError(error instanceof Error ? error.message : "Big Board 저장에 실패했습니다."); } });
$("archive-thread").addEventListener("change", (event) => void loadThread(Number((event.target as HTMLSelectElement).value)));
$("archive-search").addEventListener("submit", async (event) => { event.preventDefault(); const query = ($("archive-query") as HTMLInputElement).value.trim(); if (!query) { void loadThread(Number(($("archive-thread") as HTMLSelectElement).value)); return; } try { const found = await api<Message[]>(`/api/archive?q=${encodeURIComponent(query)}`); renderArchiveMessages(found, `“${query}” 검색 결과`); } catch (error) { showError(error instanceof Error ? error.message : "검색에 실패했습니다."); } });
$("participant-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; try { const data = new FormData(form); await api("/api/participants", { method: "POST", body: JSON.stringify({ displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions: parseOptions(String(data.get("modelOptions") ?? "{}")) }) }); form.reset(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "참가자 추가에 실패했습니다."); } });
$("connection-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form); const type = String(data.get("type")); const config: Record<string, unknown> = type === "vertex" ? { project: data.get("project"), location: data.get("location") || "global", contextTokens: 1048576 } : type === "mock" ? {} : { endpoint: data.get("endpoint"), contextTokens: Number(data.get("contextTokens")), jsonMode: true }; try { await api("/api/connections", { method: "POST", body: JSON.stringify({ name: data.get("name"), type, config, credential: String(data.get("credential") ?? "") || undefined }) }); form.reset(); configureConnectionForm(); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "Connection 저장에 실패했습니다."); } });
$("connection-type").addEventListener("change", configureConnectionForm);
$("demo-add").addEventListener("click", async () => { try { const connection = await api<Connection>("/api/connections", { method: "POST", body: JSON.stringify({ name: `데모 Mock ${new Date().toLocaleTimeString("ko-KR")}`, type: "mock", config: {} }) }); await api("/api/participants", { method: "POST", body: JSON.stringify({ displayName: "데모 참가자", connectionId: connection.id, modelId: "mock-room", modelOptions: { mockAction: "wait" } }) }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "데모 추가에 실패했습니다."); } });
$("participant-list").addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-toggle-id]"); if (!button) return; const participant = state?.participants.find((item) => item.id === button.dataset.toggleId); if (participant) void updateParticipant(participant.id, { enabled: !participant.enabled }); });
$("participant-list").addEventListener("submit", (event) => { const form = event.target as HTMLFormElement; if (!form.dataset.participantId) return; event.preventDefault(); try { const data = new FormData(form); void updateParticipant(form.dataset.participantId, { displayName: data.get("displayName"), connectionId: data.get("connectionId"), modelId: data.get("modelId"), systemPrompt: data.get("systemPrompt"), modelOptions: parseOptions(String(data.get("modelOptions") ?? "{}")) }); } catch (error) { showError(error instanceof Error ? error.message : "설정을 확인하세요."); } });
messages.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-post-id]"); if (button) void openPost(button.dataset.postId!); });
$("post-list").addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-post-id]"); if (button) void openPost(button.dataset.postId!); });
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab!)));
$("post-dialog-close").addEventListener("click", () => postDialog.close());
$("logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } finally { state = null; roomFingerprint = boardFingerprint = manageFingerprint = ""; showLogin(); } });
$("shutdown-button").addEventListener("click", async () => { if (!window.confirm("Room Server를 지금 종료할까요? 진행 중 모델 호출은 무효화되고, 이 브라우저의 Room 접근도 끊깁니다.")) return; try { await api("/api/shutdown", { method: "POST", body: "{}" }); if (refreshTimer) window.clearInterval(refreshTimer); appView.hidden = true; shutdownView.hidden = false; } catch (error) { showError(error instanceof Error ? error.message : "서버 종료 요청에 실패했습니다."); } });

async function updateParticipant(id: string, patch: Record<string, unknown>): Promise<void> { try { await api(`/api/participants/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); await refresh(); } catch (error) { showError(error instanceof Error ? error.message : "참가자 설정을 저장하지 못했습니다."); } }
function parseOptions(value: string): Record<string, unknown> { const result: unknown = JSON.parse(value); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("모델 옵션은 JSON object여야 합니다."); return result as Record<string, unknown>; }
function configureConnectionForm(): void { const form = $("connection-form") as HTMLFormElement; const type = ( $("connection-type") as HTMLSelectElement).value; for (const element of form.querySelectorAll<HTMLElement>("[data-vertex]")) element.hidden = type !== "vertex"; for (const element of form.querySelectorAll<HTMLElement>("[data-endpoint],[data-context]")) element.hidden = !(type === "oai-compatible" || type === "custom-api"); const credential = form.querySelector<HTMLElement>("[data-credential]")!; credential.hidden = type === "mock"; const input = form.querySelector<HTMLTextAreaElement>("[name=credential]")!; input.placeholder = type === "vertex" ? "서비스 계정 JSON" : "API key (서버가 보호 저장소에 보관)"; }

configureConnectionForm(); void loadState().then(showApp).catch(() => showLogin());

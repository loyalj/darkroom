"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  activeView: "monitor",
  activeRunId: null,
  manualRunId: null,   // set when user explicitly picks a run; blocks auto-detection
  logEvents: [],
  tokens: [],
  decisions: [],
  pipelineState: null,
  runMeta: null,
  runs: [],
  sse: null,
  tokenLimit: null,
  tokenLimitSource: null,
  phaseTickInterval: null,
  // Document viewer
  fileCategories: [],    // [{ label, files: [{ key, label, relPath, type, ext? }] }]
  activeCategory: null,  // currently selected category label
  activeTabKey: null,    // currently displayed tab key
  pinnedTabKey: null,    // null = auto-follow transcripts
  // Activity feed
  activity: [],
  // Factory input chat pane
  pendingInput: null,
  // Factory Memory
  memory: { data: null, activeDept: "design", activeTab: "wiki" },
  // Profiles
  profiles: { activeName: null, content: null, mode: "preview" },
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function setView(name) {
  state.activeView = name;
  $$(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === name));
  $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${name}`));
  if (name === "browser") loadRunList();
  if (name === "profiles") loadProfiles();
  if (name === "memory") loadMemoryData();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtPhaseIcon(status) {
  if (status === "done") return "✓";
  if (status === "active") return "●";
  return "○";
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenTotal(entries) {
  return entries.reduce((s, t) => s + (t.input || 0) + (t.output || 0), 0);
}

function tokenOutputTotal(entries) {
  return entries.reduce((s, t) => s + (t.output || 0), 0);
}

function fmtDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tokensByPhase(entries) {
  const phases = {};
  for (const t of entries) {
    const p = t.phase ?? "Unknown";
    phases[p] = (phases[p] ?? 0) + (t.input || 0) + (t.output || 0);
  }
  return phases;
}

// ---------------------------------------------------------------------------
// Pipeline bar
// ---------------------------------------------------------------------------

function derivePhaseTimings(logEvents, profileNodes) {
  const timings = {};
  for (const ev of logEvents) {
    const p = ev.phase;
    if (!profileNodes.includes(p)) continue;
    if (ev.event === "start" && ev.ts && !timings[p]) {
      timings[p] = { startTs: ev.ts, endTs: null };
    } else if (ev.event === `${p}-division-complete` && ev.ts && timings[p]) {
      timings[p].endTs = ev.ts;
    }
  }
  return timings;
}

function renderPipelineBar(pState) {
  const profileNodes = pState?.profileNodes ?? ["design", "build", "review", "security"];
  const phases = profileNodes.map((key) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
  }));
  const bar = $("#pipeline-bar");
  bar.innerHTML = "";

  const timings = derivePhaseTimings(state.logEvents, profileNodes);
  let hasActive = false;

  for (const { key, label } of phases) {
    const status = pState?.phases?.[key] ?? "pending";
    if (status === "active") hasActive = true;

    let timerHtml = "";
    const t = timings[key];
    if (t) {
      if (t.endTs) {
        const ms = new Date(t.endTs) - new Date(t.startTs);
        timerHtml = `<div class="phase-timer">${fmtDuration(ms)}</div>`;
      } else {
        const elapsed = Date.now() - new Date(t.startTs).getTime();
        timerHtml = `<div class="phase-timer phase-timer-active">${fmtDuration(elapsed)}</div>`;
      }
    }

    const block = document.createElement("div");
    block.className = "phase-block";
    block.innerHTML = `
      <div class="phase-label ${status}">${label}</div>
      <div class="phase-icon">${fmtPhaseIcon(status)}</div>
      ${timerHtml}
    `;
    bar.appendChild(block);
  }

  if (hasActive && !state.phaseTickInterval) {
    state.phaseTickInterval = setInterval(() => renderPipelineBar(state.pipelineState), 1000);
  } else if (!hasActive && state.phaseTickInterval) {
    clearInterval(state.phaseTickInterval);
    state.phaseTickInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Token table
// ---------------------------------------------------------------------------

function renderTokenTable(tokens) {
  const byPhase = tokensByPhase(tokens);
  const total = tokenTotal(tokens);
  const table = $("#token-table");
  const rows = Object.entries(byPhase)
    .map(([p, n]) => `<tr><td>${escHtml(p)}</td><td>${fmtTokens(n)}</td></tr>`)
    .join("");
  table.innerHTML = `${rows}
    <tr class="token-total-row">
      <td>Total</td><td>${fmtTokens(total)}</td>
    </tr>`;
  renderBudgetBar(tokens);
}

function renderBudgetBar(tokens) {
  const bar = $("#budget-bar");
  const limit = state.tokenLimit;
  if (!limit) { bar.innerHTML = ""; return; }

  const spent = tokenOutputTotal(tokens);
  const pct = Math.min((spent / limit) * 100, 100);
  const pctRound = Math.round(pct);
  const colorClass = pct >= 90 ? "budget-red" : pct >= 75 ? "budget-yellow" : "budget-green";

  bar.innerHTML = `
    <div class="budget-header">
      <span class="budget-label">Token Budget</span>
      <span class="budget-nums">${fmtTokens(spent)} / ${fmtTokens(limit)} output
        <span class="budget-source">(${escHtml(state.tokenLimitSource ?? "")})</span>
      </span>
    </div>
    <div class="budget-track">
      <div class="budget-fill ${colorClass}" style="width:${pct}%"></div>
    </div>
    <div class="budget-pct ${colorClass}">${pctRound}%</div>
  `;
}

// ---------------------------------------------------------------------------
// Decision feed
// ---------------------------------------------------------------------------

function renderDecisions(decisions) {
  const feed = $("#decision-feed");
  feed.innerHTML = "";
  if (decisions.length === 0) {
    feed.innerHTML = `<div style="color: var(--muted); font-size: 12px;">No decisions yet.</div>`;
    return;
  }
  for (const d of [...decisions].reverse()) {
    const card = document.createElement("div");
    card.className = "decision-card";
    card.innerHTML = `
      <div class="dec-point">${escHtml(d.decisionPoint ?? "?")}</div>
      <span class="dec-verdict ${escHtml(d.decision ?? "")}">${escHtml((d.decision ?? "?").toUpperCase())}</span>
      <div class="dec-reasoning">${escHtml(d.reasoning ?? "")}</div>
    `;
    feed.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Monitor header
// ---------------------------------------------------------------------------

function renderMonitorHeader(runId, pState) {
  const header = $("#monitor-header");
  const meta = state.runMeta;
  const verdict = pState?.verdict;
  const dotClass = verdict ? verdict : (pState ? "running" : "idle");
  header.innerHTML = `
    <div class="status-dot ${dotClass}"></div>
    <h2>Run Viewer</h2>
    <span class="run-id">${runId ? runId.slice(0, 8) : "—"}</span>
    ${meta?.tag ? `<span class="tag-badge">${escHtml(meta.tag)}</span>` : ""}
    <span class="subtitle" style="margin-left: auto">${escHtml(pState?.currentStep ?? "—")}</span>
  `;
}

// ---------------------------------------------------------------------------
// Tab strip (two-row: category pills + file tabs)
// ---------------------------------------------------------------------------

function renderTabStrip(categories) {
  const catRow = $("#category-row");
  const fileRow = $("#file-row");

  // Remove existing cat-btns (keep auto-btn)
  catRow.querySelectorAll(".cat-btn").forEach((el) => el.remove());

  if (!categories || categories.length === 0) {
    fileRow.innerHTML = "";
    return;
  }

  // Ensure activeCategory is valid
  const labels = categories.map((c) => c.label);
  if (!state.activeCategory || !labels.includes(state.activeCategory)) {
    state.activeCategory = labels[0];
  }

  // Render category pills before the auto-btn
  const autoBtn = $("#auto-btn");
  for (const cat of categories) {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (cat.label === state.activeCategory ? " active" : "");
    btn.textContent = cat.label;
    btn.addEventListener("click", () => {
      state.activeCategory = cat.label;
      renderFileRow(categories);
      // selecting a category doesn't pin — just navigation
    });
    catRow.insertBefore(btn, autoBtn);
  }

  renderFileRow(categories);
}

function renderFileRow(categories) {
  const fileRow = $("#file-row");
  fileRow.innerHTML = "";

  // Update active state on cat-btns
  $$(".cat-btn").forEach((btn) => btn.classList.toggle("active", btn.textContent === state.activeCategory));

  const cat = categories.find((c) => c.label === state.activeCategory);
  if (!cat) return;

  for (const file of cat.files) {
    const tab = document.createElement("button");
    tab.className = "tab-btn" + (file.key === state.activeTabKey ? " active" : "");
    tab.dataset.key = file.key;
    tab.textContent = file.label;
    tab.addEventListener("click", () => {
      state.pinnedTabKey = file.key;
      updateAutoBtn();
      selectTab(file);
    });
    fileRow.appendChild(tab);
  }
}

function updateAutoBtn() {
  $("#auto-btn").classList.toggle("auto-active", state.pinnedTabKey === null);
}

function setActiveTabVisual(key) {
  $$(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.key === key));
}

// ---------------------------------------------------------------------------
// Document content loading & rendering
// ---------------------------------------------------------------------------

async function selectTab(file, autoScroll = true) {
  if (!state.activeRunId) return;

  state.activeTabKey = file.key;
  setActiveTabVisual(file.key);

  const docBody = $("#doc-body");
  docBody.innerHTML = `<div style="color: var(--muted); padding: 20px; font-size: 13px;">Loading…</div>`;

  let data;
  try {
    const res = await fetch(`/api/runs/${state.activeRunId}/file?p=${encodeURIComponent(file.relPath)}`);
    if (!res.ok) { docBody.innerHTML = `<div style="color: var(--red); padding: 20px;">File not found.</div>`; return; }
    data = await res.json();
  } catch {
    docBody.innerHTML = `<div style="color: var(--red); padding: 20px;">Failed to load file.</div>`;
    return;
  }

  renderContent(file, data.content, autoScroll);
}

function renderContent(file, content, autoScroll = true) {
  const docBody = $("#doc-body");

  if (file.type === "transcript") {
    docBody.className = "doc-transcript";
    docBody.innerHTML = renderTranscriptHtml(content);
    if (autoScroll) docBody.scrollTop = docBody.scrollHeight;
  } else if (file.type === "markdown") {
    docBody.className = "doc-markdown";
    docBody.innerHTML = marked.parse(content);
    // Apply highlight.js to any code blocks inside markdown
    docBody.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
  } else if (file.type === "code") {
    docBody.className = "doc-code";
    const lang = file.ext ? hljs.getLanguage(file.ext) ? file.ext : "plaintext" : "plaintext";
    const highlighted = hljs.highlight(content, { language: lang }).value;
    docBody.innerHTML = `<pre><code class="hljs language-${escHtml(lang)}">${highlighted}</code></pre>`;
  } else {
    // plain text
    docBody.className = "doc-text";
    docBody.innerHTML = `<pre>${escHtml(content)}</pre>`;
  }
}

// Custom transcript renderer — colors Agent/User turns
function renderTranscriptHtml(content) {
  const lines = content.split("\n");
  return lines.map((line) => {
    if (/^## (Agent|Architect|Brain)/.test(line)) {
      return `<span class="tr-agent">${escHtml(line.replace(/^## /, ""))}</span>`;
    }
    if (/^## (User|Clarification)/.test(line)) {
      return `<span class="tr-user">${escHtml(line.replace(/^## /, ""))}</span>`;
    }
    if (line.startsWith("## ")) {
      return `<span class="tr-section">${escHtml(line.replace(/^## /, ""))}</span>`;
    }
    if (line.startsWith("# ")) {
      return `<span class="tr-heading">${escHtml(line.replace(/^# /, ""))}</span>`;
    }
    return escHtml(line);
  }).join("\n");
}

// Find a file entry by key across all categories
function findFileByKey(key) {
  for (const cat of state.fileCategories) {
    for (const f of cat.files) {
      if (f.key === key) return f;
    }
  }
  return null;
}

// Resolve transcript name ("functional") → tab key ("transcript-functional")
function transcriptKey(name) {
  return `transcript-${name}`;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

function classifyActivityLine(text) {
  if (/^\s*[→>]\s*(Bash|Read|Write|Edit|Glob|Grep|Task|WebFetch|WebSearch)/.test(text)) return "act-tool";
  if (/^\s*[✓✔]/.test(text)) return "act-ok";
  if (/^\s*[✗✘×]/.test(text)) return "act-err";
  return "";
}

function renderActivity() {
  const feed = $("#activity-feed");
  const statusEl = $("#step-status");
  if (!feed) return;

  // Most recent step/ticker event → update the current-step header
  const lastStep = [...state.activity].reverse().find(
    (a) => a.type === "step" || a.type === "ticker" || a.type === "finish" || a.type === "ticker-done"
  );

  if (lastStep) {
    let header;
    if (lastStep.type === "step") {
      header = `${lastStep.dept} · ${lastStep.phase}${lastStep.step ? `  ${lastStep.step}` : ""}`;
    } else if (lastStep.type === "finish") {
      header = `${lastStep.dept} · ${lastStep.phase}`;
    } else {
      header = lastStep.label ?? "";
    }
    $("#current-step").textContent = header;
  }

  // Most recent status/step event → update sub-status line
  const lastStatus = [...state.activity].reverse().find(
    (a) => a.type === "status" || a.type === "step"
  );
  if (lastStatus?.status) {
    statusEl.textContent = `↪ ${lastStatus.status}`;
  } else {
    statusEl.textContent = "";
  }

  // Render line events in the scrolling feed
  const lineEvents = state.activity.filter(
    (a) => (a.type === "line" || a.type === "finish" || a.type === "ticker-done" || a.type === "ticker-fail" || a.type === "ticker") &&
           a.subtype !== "interview" &&
           (a.text || a.summary || a.label || a.reason)
  );

  feed.innerHTML = "";
  for (const ev of lineEvents.slice(-60)) {
    const div = document.createElement("div");
    let text = "";
    if (ev.type === "line") {
      text = ev.text;
      div.className = "act-line " + classifyActivityLine(text);
    } else if (ev.type === "finish") {
      text = `✓ ${ev.phase} — ${ev.summary}`;
      div.className = "act-line act-finish";
    } else if (ev.type === "ticker-done") {
      text = `✓ ${ev.summary || ev.label}`;
      div.className = "act-line act-finish";
    } else if (ev.type === "ticker-fail") {
      text = `✗ ${ev.reason}`;
      div.className = "act-line act-err";
    } else if (ev.type === "ticker") {
      text = ev.label;
      div.className = "act-line act-ticker";
    }
    div.textContent = text;
    feed.appendChild(div);
  }

  feed.scrollTop = feed.scrollHeight;
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function connectRun(runId) {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.phaseTickInterval) { clearInterval(state.phaseTickInterval); state.phaseTickInterval = null; }
  if (!runId) return;

  state.activeRunId = runId;
  state.logEvents = [];
  state.tokens = [];
  state.decisions = [];
  state.pipelineState = null;
  state.runMeta = null;
  state.fileCategories = [];
  state.activeCategory = null;
  state.activeTabKey = null;
  state.pinnedTabKey = null;
  state.tokenLimit = null;
  state.tokenLimitSource = null;
  state.activity = [];
  hideInputPane();

  // Fetch meta for tag display
  fetch(`/api/runs/${runId}`)
    .then((r) => r.json())
    .then((d) => { state.runMeta = d.meta; renderMonitorHeader(runId, state.pipelineState); })
    .catch(() => {});

  const sse = new EventSource(`/api/runs/${runId}/stream`);
  state.sse = sse;

  sse.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "snapshot") {
      state.logEvents = msg.logEvents ?? [];
      state.tokens = msg.tokens ?? [];
      state.decisions = msg.decisions ?? [];
      state.pipelineState = msg.state;
      state.fileCategories = msg.files ?? [];
      state.tokenLimit = msg.tokenLimit ?? null;
      state.tokenLimitSource = msg.tokenLimitSource ?? null;
      if (msg.pendingInput) showInputPane(msg.pendingInput.prompt, msg.pendingInput.options ?? null, msg.pendingInput.type ?? "text");
      state.activity = msg.recentActivity ?? [];
      renderAll();

    } else if (msg.type === "log") {
      state.logEvents.push(...(msg.newEvents ?? []));
      state.pipelineState = msg.state;
      renderMonitorHeader(state.activeRunId, state.pipelineState);
      renderPipelineBar(state.pipelineState);
      $("#current-step").textContent = state.pipelineState?.currentStep ?? "Waiting…";
      renderActivity();

    } else if (msg.type === "budget") {
      state.tokenLimit = msg.tokenLimit ?? null;
      state.tokenLimitSource = msg.tokenLimitSource ?? null;
      renderBudgetBar(state.tokens);

    } else if (msg.type === "tokens") {
      state.tokens.push(...(msg.newTokens ?? []));
      renderTokenTable(state.tokens);

    } else if (msg.type === "decisions") {
      state.decisions.push(...(msg.newDecisions ?? []));
      renderDecisions(state.decisions);

    } else if (msg.type === "files") {
      state.fileCategories = msg.files ?? [];
      renderTabStrip(state.fileCategories);

    } else if (msg.type === "activity") {
      state.activity.push(...(msg.newActivity ?? []));
      if (state.activity.length > 200) state.activity = state.activity.slice(-200);
      renderActivity();

    } else if (msg.type === "pending-input") {
      showInputPane(msg.prompt, msg.options ?? null, msg.inputType ?? "text");

    } else if (msg.type === "input-cleared") {
      hideInputPane();

    } else if (msg.type === "transcript") {
      const key = transcriptKey(msg.name);
      const file = findFileByKey(key);
      if (!file) return;

      if (state.pinnedTabKey === null || state.pinnedTabKey === key) {
        // Auto-follow: switch category to Transcripts, switch tab, reload content
        state.activeCategory = "Transcripts";
        state.activeTabKey = key;
        renderFileRow(state.fileCategories);
        setActiveTabVisual(key);
        selectTab(file, true);
      } else if (state.activeTabKey === key) {
        selectTab(file, true);
      }
    }
  };

  sse.onerror = () => {}; // EventSource auto-reconnects
}

function renderAll() {
  renderMonitorHeader(state.activeRunId, state.pipelineState);
  renderPipelineBar(state.pipelineState);
  $("#current-step").textContent = state.pipelineState?.currentStep ?? "Waiting…";
  renderTokenTable(state.tokens);
  renderDecisions(state.decisions);
  renderTabStrip(state.fileCategories);
  updateAutoBtn();
  renderActivity();
}

// ---------------------------------------------------------------------------
// Idle state
// ---------------------------------------------------------------------------

function showIdleState() {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.phaseTickInterval) { clearInterval(state.phaseTickInterval); state.phaseTickInterval = null; }
  state.activeRunId = null;
  state.logEvents = [];
  state.tokens = [];
  state.decisions = [];
  state.pipelineState = null;
  state.runMeta = null;
  state.fileCategories = [];
  state.activeCategory = null;
  state.activeTabKey = null;
  state.pinnedTabKey = null;
  state.tokenLimit = null;
  state.tokenLimitSource = null;

  $("#monitor-header").innerHTML = `
    <div class="status-dot idle"></div>
    <h2>Run Viewer</h2>
    <span class="subtitle" style="margin-left: auto; color: var(--muted);">Waiting for a run…</span>
  `;

  renderPipelineBar(null);
  $("#current-step").textContent = "Ready to monitor";
  $("#token-table").innerHTML = `<tr><td colspan="2" style="color: var(--muted); padding: 4px 0;">No data yet</td></tr>`;
  $("#decision-feed").innerHTML = `<div style="color: var(--muted); font-size: 12px;">No decisions yet.</div>`;

  const catRow = $("#category-row");
  catRow.querySelectorAll(".cat-btn").forEach((el) => el.remove());
  $("#file-row").innerHTML = "";
  $("#doc-body").className = "";
  $("#doc-body").innerHTML = `<div class="empty-state"><span>No run in progress</span><span class="hint">Start the factory to begin monitoring</span></div>`;
  state.activity = [];
  $("#step-status").textContent = "";
  $("#activity-feed").innerHTML = "";
  hideInputPane();
}

// ---------------------------------------------------------------------------
// Auto-detect active run
// ---------------------------------------------------------------------------

async function detectActiveRun() {
  if (state.manualRunId) return;  // user picked a run explicitly — don't override
  try {
    const res = await fetch("/api/active");
    const { id } = await res.json();
    if (id && id !== state.activeRunId) {
      connectRun(id);
    } else if (!id && state.activeRunId) {
      // Run just completed — return to idle
      showIdleState();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Run browser
// ---------------------------------------------------------------------------

async function loadRunList() {
  const body = $("#run-list-body");
  body.innerHTML = `<div style="color: var(--muted); padding: 20px;">Loading…</div>`;

  let runs;
  try {
    const res = await fetch("/api/runs");
    runs = await res.json();
  } catch {
    body.innerHTML = `<div style="color: var(--red); padding: 20px;">Failed to load runs.</div>`;
    return;
  }

  state.runs = runs;

  if (runs.length === 0) {
    body.innerHTML = `<div class="empty-state"><span>No runs yet</span><span class="hint">Start the factory to create a run</span></div>`;
    return;
  }

  body.innerHTML = "";

  for (const run of runs) {
    const row = document.createElement("div");
    row.className = "run-row";
    row.innerHTML = `
      <span class="verdict-pill ${run.verdict ?? "running"}">${run.verdict ?? "running"}</span>
      <span class="run-id">${run.id.slice(0, 8)}</span>
      ${run.tag ? `<span class="tag-badge">${escHtml(run.tag)}</span>` : ""}
      <span class="run-tokens">${fmtTokens(run.totalTokens ?? 0)}</span>
      <span class="run-ts">${fmtTs(run.startTs)}</span>
    `;
    row.addEventListener("click", () => {
      state.manualRunId = run.id;
      connectRun(run.id);
      setView("monitor");
    });
    body.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Factory input chat pane
// ---------------------------------------------------------------------------

function showInputPane(prompt, options = null, type = "text") {
  state.pendingInput = prompt;
  const pane = $("#chat-pane");
  pane.classList.remove("idle");
  pane.classList.add("active");
  $("#chat-query").textContent = prompt;

  const optionsEl = $("#chat-options");
  const inputRow = $("#chat-input-row");

  const hasSimpleOptions = options && options.length > 0 && options.every((o) => !/<[^>]+>/.test(o));
  const showTextarea = !hasSimpleOptions || type === "hybrid";

  if (hasSimpleOptions) {
    optionsEl.innerHTML = "";
    options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "chat-opt-btn";
      btn.textContent = opt;
      if (i === 0) btn.classList.add("opt-primary");
      if (/\babort\b|\bcancel\b/i.test(opt)) btn.classList.add("opt-danger");
      btn.addEventListener("click", () => submitOption(opt));
      optionsEl.appendChild(btn);
    });
    optionsEl.style.display = "flex";
  } else {
    optionsEl.style.display = "none";
  }

  if (showTextarea) {
    inputRow.style.display = "flex";
    const field = $("#chat-field");
    field.value = "";
    field.disabled = false;
    field.placeholder = "Type your response… (Enter to send, Shift+Enter for new line)";
    $("#chat-submit").disabled = false;
    setTimeout(() => field.focus(), 50);
  } else {
    inputRow.style.display = "none";
  }
}

function hideInputPane() {
  state.pendingInput = null;
  const pane = $("#chat-pane");
  pane.classList.remove("active");
  pane.classList.add("idle");
  $("#chat-query").textContent = "";
  const optionsEl = $("#chat-options");
  optionsEl.style.display = "none";
  optionsEl.innerHTML = "";
  const inputRow = $("#chat-input-row");
  inputRow.style.display = "flex";
  const field = $("#chat-field");
  field.value = "";
  field.disabled = true;
  field.placeholder = "Waiting for factory…";
  $("#chat-submit").disabled = true;
}

function submitOption(value) {
  if (!state.activeRunId) return;
  $$(".chat-opt-btn").forEach((b) => { b.disabled = true; });
  fetch(`/api/runs/${state.activeRunId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: value }),
  })
    .then(() => hideInputPane())
    .catch(() => { $$(".chat-opt-btn").forEach((b) => { b.disabled = false; }); });
}

function submitInputPane() {
  const response = $("#chat-field").value.trim();
  if (!response || !state.activeRunId) return;

  const btn = $("#chat-submit");
  btn.disabled = true;

  fetch(`/api/runs/${state.activeRunId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response }),
  })
    .then(() => hideInputPane())
    .catch(() => { btn.disabled = false; });
}

// ---------------------------------------------------------------------------
// Factory Profiles
// ---------------------------------------------------------------------------

function setProfilesMode(mode) {
  state.profiles.mode = mode;
  $("#profiles-main").className = `mode-${mode}`;
  $$(".profiles-mode-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  if (mode === "preview") renderProfileGraph($("#profiles-editor").value);
}

async function loadProfiles() {
  const sidebar = $("#profiles-sidebar");
  sidebar.innerHTML = `<div style="color: var(--muted); padding: 12px 14px; font-size: 12px;">Loading…</div>`;
  try {
    const res = await fetch("/api/profiles");
    const profiles = await res.json();
    sidebar.innerHTML = "";
    if (profiles.length === 0) {
      sidebar.innerHTML = `<div style="color: var(--muted); padding: 12px 14px; font-size: 12px;">No profiles</div>`;
      return;
    }
    for (const p of profiles) {
      const item = document.createElement("div");
      item.className = "profile-item" + (p.name === state.profiles.activeName ? " active" : "");
      item.innerHTML = `
        <span>${escHtml(p.name)}</span>
        <span class="profile-item-nodes">${p.nodeCount}n</span>
      `;
      item.addEventListener("click", () => loadProfile(p.name));
      sidebar.appendChild(item);
    }
    if (!state.profiles.activeName && profiles.length > 0) {
      loadProfile(profiles[0].name);
    }
  } catch {
    sidebar.innerHTML = `<div style="color: var(--red); padding: 12px 14px; font-size: 12px;">Failed to load</div>`;
  }
}

async function loadProfile(name) {
  state.profiles.activeName = name;
  $$(".profile-item").forEach((el) => {
    el.classList.toggle("active", el.querySelector("span")?.textContent === name);
  });
  const editor = $("#profiles-editor");
  const errEl = $("#profiles-editor-error");
  editor.value = "Loading…";
  editor.disabled = true;
  errEl.textContent = "";
  $("#profiles-save-btn").disabled = true;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
    const data = await res.json();
    editor.value = data.content;
    editor.disabled = false;
    state.profiles.content = data.content;
    $("#profiles-save-btn").disabled = false;
    renderProfileGraph(data.content);
  } catch {
    editor.value = "";
    errEl.textContent = "Failed to load profile.";
  }
}

async function saveProfile() {
  const name = state.profiles.activeName;
  if (!name) return;
  const content = $("#profiles-editor").value;
  const errEl = $("#profiles-editor-error");
  const btn = $("#profiles-save-btn");
  const badge = $("#profiles-saved-badge");

  try { JSON.parse(content); } catch (e) {
    errEl.textContent = `Invalid JSON: ${e.message}`;
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error ?? "Save failed.";
    } else {
      errEl.textContent = "";
      state.profiles.content = content;
      badge.textContent = "Saved ✓";
      setTimeout(() => { badge.textContent = ""; }, 2000);
      loadProfiles();
    }
  } catch {
    errEl.textContent = "Save failed.";
  } finally {
    btn.disabled = false;
  }
}

function renderProfileGraph(jsonText) {
  const pane = $("#profiles-graph-pane");
  pane.innerHTML = "";

  let profile;
  try { profile = JSON.parse(jsonText); } catch {
    pane.innerHTML = `<div style="color: var(--muted); font-size: 12px; padding: 4px 0;">Invalid JSON — fix editor to preview</div>`;
    return;
  }

  const nodes = profile.nodes ?? [];
  if (nodes.length === 0) {
    pane.innerHTML = `<div style="color: var(--muted); font-size: 12px; padding: 4px 0;">No nodes defined</div>`;
    return;
  }

  // Profile header
  const budgetPts = (profile.budgetCheckpoints ?? []).length;
  pane.innerHTML = `
    <div class="graph-profile-header">${escHtml(profile.name ?? profile.id ?? "Untitled")}</div>
    <div class="graph-profile-meta">${nodes.length} node${nodes.length === 1 ? "" : "s"}${budgetPts ? ` · ${budgetPts} budget checkpoint${budgetPts === 1 ? "" : "s"}` : ""}</div>
  `;

  // Build edge index
  const fwdEdges = {};   // from -> edge
  const backEdges = {};  // from -> [edges]
  for (const edge of (profile.edges ?? [])) {
    if (edge.type === "backward") {
      (backEdges[edge.from] = backEdges[edge.from] ?? []).push(edge);
    } else {
      fwdEdges[edge.from] = edge;
    }
  }

  // Budget checkpoint set
  const budgetAfter = new Set(
    (profile.budgetCheckpoints ?? []).map((b) => b.replace(/^after:/, ""))
  );

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const card = document.createElement("div");
    card.className = "graph-node";

    // ID line
    const idEl = document.createElement("div");
    idEl.className = `graph-node-id ${escHtml(node.id ?? "")}`;
    idEl.textContent = node.id ?? "?";
    card.appendChild(idEl);

    // Runner filename
    if (node.runner) {
      const runnerEl = document.createElement("div");
      runnerEl.className = "graph-node-runner";
      runnerEl.textContent = node.runner.split("/").pop();
      card.appendChild(runnerEl);
    }

    // Badges: skip conditions, feedback loop, budget checkpoint
    const badgesEl = document.createElement("div");
    badgesEl.className = "graph-node-badges";
    if (node.skipIf) {
      badgesEl.innerHTML += `<span class="graph-badge skip" title="Skip if file exists: ${escHtml(node.skipIf)}">skip if file</span>`;
    }
    if (node.skipIfEvent) {
      badgesEl.innerHTML += `<span class="graph-badge skip" title="Skip if event: ${escHtml(node.skipIfEvent)}">skip if: ${escHtml(node.skipIfEvent)}</span>`;
    }
    if (node.feedbackLoop) {
      badgesEl.innerHTML += `<span class="graph-badge loop">↺ feedback loop</span>`;
    }
    if (budgetAfter.has(node.id)) {
      badgesEl.innerHTML += `<span class="graph-badge budget">budget check</span>`;
    }
    if (badgesEl.innerHTML) card.appendChild(badgesEl);

    // Divider before memory
    const mem = node.memory;
    if (mem) {
      card.appendChild(Object.assign(document.createElement("hr"), { className: "graph-node-divider" }));
      const wikis = mem.readWiki?.length ? mem.readWiki.join(", ") : "none";
      const runs  = mem.readRuns?.length ? mem.readRuns.join(", ") : "none";
      const write = mem.write ?? "—";
      const memEl = document.createElement("div");
      memEl.className = "graph-node-mem";
      memEl.innerHTML = `wiki in: ${escHtml(wikis)}<br>runs in: ${escHtml(runs)}<br>writes: ${escHtml(write)}`;
      card.appendChild(memEl);
    }

    // Backward edges originating from this node
    const backs = backEdges[node.id] ?? [];
    if (backs.length) {
      const backEl = document.createElement("div");
      backEl.className = "graph-node-back";
      backEl.innerHTML = backs
        .map((e) => `↩ on: ${escHtml(e.on ?? "?")} → ${escHtml(e.to ?? "?")}`)
        .join("<br>");
      card.appendChild(backEl);
    }

    pane.appendChild(card);

    // Arrow to next node
    if (i < nodes.length - 1) {
      const fwd = fwdEdges[node.id];
      const arrow = document.createElement("div");
      arrow.className = "graph-arrow";
      arrow.innerHTML = `<span>↓</span>${fwd?.on ? `<span class="graph-arrow-cond">on: ${escHtml(fwd.on)}</span>` : ""}`;
      pane.appendChild(arrow);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory Memory
// ---------------------------------------------------------------------------

async function loadMemoryData() {
  const content = $("#memory-content");
  content.className = "";
  content.innerHTML = `<div style="color: var(--muted); padding: 20px; font-size: 13px;">Loading…</div>`;
  try {
    const res = await fetch("/api/memory");
    state.memory.data = await res.json();
  } catch {
    content.innerHTML = `<div style="color: var(--red); padding: 20px;">Failed to load memory.</div>`;
    return;
  }
  renderMemoryView();
}

function renderMemoryView() {
  const { data, activeDept, activeTab } = state.memory;
  if (!data) return;

  const deptRow = $("#memory-dept-row");
  deptRow.innerHTML = "";
  for (const dept of data.departments) {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (dept === activeDept ? " active" : "");
    btn.textContent = dept.charAt(0).toUpperCase() + dept.slice(1);
    btn.addEventListener("click", () => {
      state.memory.activeDept = dept;
      deptRow.querySelectorAll(".cat-btn").forEach((b) =>
        b.classList.toggle("active", b.textContent.toLowerCase() === dept)
      );
      renderMemoryContent();
    });
    deptRow.appendChild(btn);
  }

  const tabRow = $("#memory-tab-row");
  tabRow.innerHTML = "";
  for (const [tab, label] of [["wiki", "Wiki"], ["runs", "Run Log"]]) {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (tab === activeTab ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      state.memory.activeTab = tab;
      tabRow.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderMemoryContent();
    });
    tabRow.appendChild(btn);
  }

  renderMemoryContent();
}

function renderMemoryContent() {
  const { activeDept, activeTab } = state.memory;
  if (activeTab === "wiki") renderMemoryWiki(activeDept);
  else renderMemoryRunLog(activeDept);
}

function renderMemoryWiki(dept) {
  const content = $("#memory-content");
  const deptData = state.memory.data?.data?.[dept];
  if (!deptData?.wiki) {
    content.className = "";
    const label = dept.charAt(0).toUpperCase() + dept.slice(1);
    content.innerHTML = `
      <div class="empty-state">
        <span>No wiki entries yet for ${escHtml(label)}</span>
        <span class="hint">Craft knowledge accumulates here after completed runs. The factory learns over time.</span>
      </div>`;
    return;
  }
  content.className = "mem-wiki";
  content.innerHTML = marked.parse(deptData.wiki);
  content.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
}

function renderMemoryRunLog(dept) {
  const content = $("#memory-content");
  const deptData = state.memory.data?.data?.[dept];
  if (!deptData?.runs?.length) {
    content.className = "";
    const label = dept.charAt(0).toUpperCase() + dept.slice(1);
    content.innerHTML = `
      <div class="empty-state">
        <span>No run records yet for ${escHtml(label)}</span>
        <span class="hint">Run the factory to see structured records of each completed run.</span>
      </div>`;
    return;
  }
  content.className = "mem-run-log";
  content.innerHTML = "";
  for (const run of [...deptData.runs].reverse()) {
    const record = run.record ?? run;
    const projectName = record.projectName ?? "Unknown project";
    const outcome = record.outcome ?? "";
    const ts = run.ts ? fmtTs(run.ts) : "";

    const el = document.createElement("div");
    el.className = "run-record";

    const header = document.createElement("div");
    header.className = "run-record-header";
    header.innerHTML = `
      <span class="run-record-toggle">▶</span>
      <span class="run-record-name">${escHtml(projectName)}</span>
      ${outcome ? `<span class="run-record-outcome">${escHtml(outcome)}</span>` : ""}
      <span class="run-record-ts">${escHtml(ts)}</span>
    `;

    const body = document.createElement("div");
    body.className = "run-record-body";
    body.style.display = "none";
    const rows = Object.entries(record)
      .map(([k, v]) => `<tr>
        <td class="run-field-key">${escHtml(k)}</td>
        <td class="run-field-val">${escHtml(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v ?? ""))}</td>
      </tr>`)
      .join("");
    body.innerHTML = `<table class="run-field-table">${rows}</table>`;

    header.addEventListener("click", () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      header.querySelector(".run-record-toggle").textContent = open ? "▶" : "▼";
    });

    el.appendChild(header);
    el.appendChild(body);
    content.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // Configure marked for safe rendering
  marked.setOptions({ breaks: true });

  // Sidebar toggle
  $("#sidebar-toggle").addEventListener("click", () => {
    $("#sidebar").classList.toggle("collapsed");
  });

  // Nav
  $$(".nav-item").forEach((el) => {
    el.addEventListener("click", () => {
      // Expand sidebar if collapsed when user clicks a nav item
      $("#sidebar").classList.remove("collapsed");
      setView(el.dataset.view);
    });
  });

  // Auto button — unpin and return to auto-follow
  $("#auto-btn").addEventListener("click", () => {
    state.pinnedTabKey = null;
    updateAutoBtn();
  });

  // Chat input pane
  $("#chat-submit").addEventListener("click", submitInputPane);
  $("#chat-field").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInputPane(); }
  });

  // Chat pane drag-to-resize
  let dragStart = null;
  $("#chat-resize").addEventListener("mousedown", (e) => {
    dragStart = { y: e.clientY, h: $("#chat-pane").offsetHeight };
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    const newH = Math.max(90, Math.min(600, dragStart.h + (dragStart.y - e.clientY)));
    $("#chat-pane").style.height = newH + "px";
  });
  document.addEventListener("mouseup", () => { dragStart = null; });

  // Profiles
  $$(".profiles-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setProfilesMode(btn.dataset.mode));
  });
  $("#profiles-save-btn").addEventListener("click", saveProfile);
  $("#profiles-editor").addEventListener("input", () => {
    renderProfileGraph($("#profiles-editor").value);
  });

  $("#memory-refresh-btn").addEventListener("click", loadMemoryData);

  setView("monitor");
  detectActiveRun();
  setInterval(detectActiveRun, 3000);
});

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  activeView: "launch",
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
  memory: { data: null, activeDept: "design", activeTab: "wiki", editMode: false },
  // Factory Org
  org: { roles: [], activeRoleId: null, session: null },
  orgCharts: { profiles: [], activeProfile: null, nodes: [] },
  // Factory Workers
  workers: { list: [], slots: [], activeId: null },
  // Profiles
  profiles: { activeName: null, content: null, mode: "preview", drawflow: null, depts: {} },
  // Department colors (loaded from /api/departments, shared across all views)
  deptColors: {},
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
  if (name === "launch") initLaunchView();
  if (name === "profiles") loadProfiles();
  if (name === "memory") loadMemoryData();
  if (name === "staff") loadStaffData();
  if (name === "orgcharts") loadOrgChartsData();
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

const PHASE_STEPS = {
  design:   ["Functional Interview", "Experience Interview", "Consistency Check", "Spec Generation"],
  build:    ["Architect Interview", "Building", "Copy Review", "Verification", "Packaging"],
  review:   ["Running Scenarios", "Verdict"],
  security: ["Running", "Verdict"],
};

function getPhaseStepIndex(phase, currentStep) {
  if (!currentStep) return -1;
  const dot = currentStep.indexOf(" · ");
  if (dot === -1) return -1;
  const stepPhase = currentStep.slice(0, dot).toLowerCase();
  const rawStep   = currentStep.slice(dot + 3);
  if (stepPhase !== phase) return -1;
  if (["Complete", "Shipped", "Blocked", "Approved"].includes(rawStep)) return Infinity;
  let normalized = rawStep;
  if (phase === "build"  && rawStep.startsWith("Task "))     normalized = "Building";
  if (phase === "review" && rawStep.startsWith("Scenario ")) normalized = "Running Scenarios";
  if (phase === "design" && rawStep === "Clarification")     normalized = "Spec Generation";
  return (PHASE_STEPS[phase] ?? []).indexOf(normalized);
}

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
      if (t.endTs || status === "failed") {
        const ms = t.endTs ? new Date(t.endTs) - new Date(t.startTs) : Date.now() - new Date(t.startTs).getTime();
        timerHtml = `<div class="phase-timer">${fmtDuration(ms)}</div>`;
      } else {
        const elapsed = Date.now() - new Date(t.startTs).getTime();
        timerHtml = `<div class="phase-timer phase-timer-active">${fmtDuration(elapsed)}</div>`;
      }
    } else {
      timerHtml = `<div class="phase-timer phase-timer-pending">0:00</div>`;
    }

    const steps = PHASE_STEPS[key] ?? [];
    const rawIndex = status === "active" ? getPhaseStepIndex(key, pState?.currentStep) : -1;
    const allDone  = status === "done" || rawIndex === Infinity;
    const stepIdx  = rawIndex === Infinity ? steps.length : rawIndex;

    const segmentsHtml = steps.map((_, i) => {
      let cls = "phase-segment";
      if (status === "failed")   cls += " failed";
      else if (allDone)          cls += " done";
      else if (i < stepIdx)      cls += " done";
      else if (i === stepIdx)    cls += " active";
      return `<div class="${cls}"></div>`;
    }).join("");

    const block = document.createElement("div");
    block.className = "phase-block";
    block.innerHTML = `
      <div class="phase-label ${status}">${label}</div>
      <div class="phase-segments">${segmentsHtml}</div>
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

  let rows;
  if (Object.keys(byPhase).length > 0) {
    rows = Object.entries(byPhase)
      .map(([p, n]) => `<tr><td>${escHtml(p)}</td><td>${fmtTokens(n)}</td></tr>`)
      .join("");
  } else {
    const placeholders = state.pipelineState?.profileNodes ?? ["design", "build", "review", "security"];
    rows = placeholders
      .map((p) => {
        const label = p.charAt(0).toUpperCase() + p.slice(1);
        return `<tr style="color: var(--subtle)"><td>${escHtml(label)}</td><td>0</td></tr>`;
      })
      .join("");
  }

  table.innerHTML = `${rows}
    <tr class="token-total-row">
      <td>Total</td><td>${fmtTokens(total) || "0"}</td>
    </tr>`;
  renderBudgetBar(tokens);
}

function renderBudgetBar(tokens) {
  const bar = $("#budget-bar");
  const limit = state.tokenLimit;
  const spent = tokenOutputTotal(tokens);

  if (!limit) {
    bar.innerHTML = `<span class="budget-no-limit">No token budget set</span>`;
    return;
  }

  const pct = Math.min((spent / limit) * 100, 100);
  const pctRound = Math.round(pct);
  const colorClass = pct >= 90 ? "budget-red" : pct >= 75 ? "budget-yellow" : "budget-green";

  bar.innerHTML = `
    <div class="budget-header">
      <span class="budget-label">Token Budget</span>
      <span class="budget-nums">${fmtTokens(spent)} / ${fmtTokens(limit)}</span>
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

function ghostDecisionCards() {
  const card = (titleW, lines) => `
    <div class="decision-card decision-card-ghost">
      <div class="ghost-bar" style="width:${titleW}%;height:10px;margin-bottom:4px;"></div>
      <div class="ghost-bar" style="width:36px;height:15px;border-radius:3px;margin-bottom:4px;"></div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${lines.map(w => `<div class="ghost-bar" style="width:${w}%;height:8px;"></div>`).join("")}
      </div>
    </div>`;
  return card(58, [100, 83, 91]) + card(47, [100, 72]) + card(63, [100, 88, 76]);
}

function renderDecisions(decisions) {
  const feed = $("#decision-feed");
  feed.innerHTML = "";
  if (decisions.length === 0) {
    feed.innerHTML = ghostDecisionCards();
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

  catRow.querySelectorAll(".cat-btn").forEach((el) => el.remove());

  if (!categories || categories.length === 0) {
    $("#file-row").querySelectorAll(".tab-btn").forEach((el) => el.remove());
    $("#auto-btn").hidden = true;
    return;
  }

  // Ensure activeCategory is valid
  const labels = categories.map((c) => c.label);
  if (!state.activeCategory || !labels.includes(state.activeCategory)) {
    state.activeCategory = labels[0];
  }

  for (const cat of categories) {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (cat.label === state.activeCategory ? " active" : "");
    btn.textContent = cat.label;
    btn.addEventListener("click", () => {
      state.activeCategory = cat.label;
      renderFileRow(categories);
    });
    catRow.appendChild(btn);
  }

  renderFileRow(categories);
}

function renderFileRow(categories) {
  const fileRow = $("#file-row");
  const autoBtn = $("#auto-btn");

  // Clear tab buttons but preserve the auto-btn DOM node
  fileRow.querySelectorAll(".tab-btn").forEach((el) => el.remove());

  // Update active state on cat-btns
  $$(".cat-btn").forEach((btn) => btn.classList.toggle("active", btn.textContent === state.activeCategory));

  const cat = categories.find((c) => c.label === state.activeCategory);
  if (!cat) {
    autoBtn.hidden = true;
    return;
  }

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
    fileRow.insertBefore(tab, autoBtn);
  }

  autoBtn.hidden = state.activeCategory !== "Transcripts";
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
  let sseErrorStreak = 0;

  sse.onmessage = (ev) => {
    sseErrorStreak = 0;
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
      $("#step-status").textContent = state.pipelineState?.failReason ?? "";
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

  sse.onerror = () => {
    const v = state.pipelineState?.verdict;
    // Terminal state — run is done, no need to keep the connection open
    if (v && v !== "running") { sse.close(); state.sse = null; return; }
    // No terminal state yet — EventSource will auto-reconnect; show warning after repeated failures
    sseErrorStreak++;
    if (sseErrorStreak >= 4) {
      $("#current-step").textContent = "Connection lost — run status unknown";
      renderMonitorHeader(state.activeRunId, null);
    }
  };
}

function renderAll() {
  renderMonitorHeader(state.activeRunId, state.pipelineState);
  renderPipelineBar(state.pipelineState);
  $("#current-step").textContent = state.pipelineState?.currentStep ?? "Waiting…";
  $("#step-status").textContent = state.pipelineState?.failReason ?? "";
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
  renderTokenTable([]);
  $("#decision-feed").innerHTML = ghostDecisionCards();

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
// Launch view
// ---------------------------------------------------------------------------

const launchState = {
  initialized: false,
  profiles: [],
  selectedProfile: null,
  sourceRunId: null,
  sourceRunRequired: false,
  stopAfter: null,
  mode: "manual",
};

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

async function ensureDepts() {
  if (Object.keys(state.profiles.depts).length) return state.profiles.depts;
  try {
    const res = await fetch("/api/departments");
    const data = await res.json();
    state.profiles.depts = data;
    for (const [id, val] of Object.entries(data)) {
      state.deptColors[id] = typeof val === "string" ? val : (val.color ?? "#888");
    }
  } catch {}
  return state.profiles.depts;
}

async function ensureDeptColors() {
  await ensureDepts();
}

function nodeInlineStyle(id) {
  const color = state.deptColors[id?.toLowerCase()];
  if (!color) return "";
  return `color:${color};background:${hexToRgba(color, 0.12)};border-color:${hexToRgba(color, 0.4)};`;
}

async function initLaunchView() {
  if (launchState.initialized) return;
  launchState.initialized = true;

  $$("#view-launch .launch-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#view-launch .launch-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      launchState.mode = btn.dataset.mode;
    });
  });

  $("#launch-btn").addEventListener("click", handleLaunch);

  try {
    await ensureDeptColors();
    const profilesRes = await fetch("/api/profiles");
    launchState.profiles = await profilesRes.json();
  } catch {
    launchState.profiles = [];
  }
  renderLaunchProfileGrid();
}

function renderLaunchProfileGrid() {
  const grid = $("#launch-profile-grid");
  grid.innerHTML = "";
  if (launchState.profiles.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;">No profiles found.</div>`;
    return;
  }
  for (const profile of launchState.profiles) {
    const card = document.createElement("div");
    card.className = "profile-launch-card" + (launchState.selectedProfile === profile.name ? " selected" : "");
    const pipelineHtml = (profile.nodes ?? []).map((n, i) =>
      (i > 0 ? `<span class="profile-mini-arrow">›</span>` : "") +
      `<span class="profile-mini-node" style="${nodeInlineStyle(n)}">${escHtml(n)}</span>`
    ).join("");
    card.innerHTML = `
      <div class="profile-launch-card-name">${escHtml(profile.name)}</div>
      ${profile.description ? `<div class="profile-launch-card-desc">${escHtml(profile.description)}</div>` : ""}
      <div class="profile-mini-pipeline">${pipelineHtml}</div>
    `;
    card.addEventListener("click", () => selectLaunchProfile(profile));
    grid.appendChild(card);
  }
}

function selectLaunchProfile(profile) {
  launchState.selectedProfile = profile.name;
  launchState.stopAfter = null;
  launchState.sourceRunId = null;
  launchState.sourceRunRequired = profile.requiresRun ?? false;
  renderLaunchProfileGrid();
  renderStopAfterRail(profile.nodes ?? []);
  updateLaunchButton();
  populateSourceRunSelect();
}

function updateLaunchButton() {
  const btn = $("#launch-btn");
  if (!launchState.selectedProfile) {
    btn.disabled = true;
    btn.textContent = "Select a profile";
  } else if (launchState.sourceRunRequired && !launchState.sourceRunId) {
    btn.disabled = true;
    btn.textContent = "Select a source run";
  } else {
    btn.disabled = false;
    btn.textContent = "Launch Run";
  }
}

async function populateSourceRunSelect() {
  const profileName = launchState.selectedProfile;
  const profile = launchState.profiles.find((p) => p.name === profileName);
  const sourceSection = $("#launch-source-section");
  const sel = $("#launch-source-select");

  // Start hidden while loading to avoid a flash for profiles with no eligible runs
  sourceSection.hidden = true;
  launchState.sourceRunId = null;
  updateLaunchButton();

  let runs;
  try {
    const res = await fetch(`/api/runs/eligible?profile=${encodeURIComponent(profileName)}`);
    runs = await res.json();
  } catch {
    runs = [];
  }

  // Profile may have changed while fetch was in flight — discard stale result
  if (launchState.selectedProfile !== profileName) return;

  const hint = $("#launch-source-hint");
  if (hint) hint.textContent = profile?.requiresRun ? "— required to continue from existing artifacts" : "— optional: continue from an existing run or leave blank to start fresh";

  if (!runs.length) {
    if (profile?.requiresRun) {
      // Required but nothing available — show disabled dropdown, block launch
      sel.innerHTML = `<option value="">No eligible runs found</option>`;
      sel.disabled = true;
      sourceSection.hidden = false;
    }
    // Optional and nothing available — keep section hidden, launch fresh
  } else {
    const placeholder = profile?.requiresRun ? "Select a run…" : "Select a run (optional)…";
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      runs.map((r) => {
        const parts = [r.id.slice(0, 8), r.tag, r.profile, r.verdict].filter(Boolean);
        return `<option value="${escHtml(r.id)}">${escHtml(parts.join(" · "))}</option>`;
      }).join("");
    sel.disabled = false;
    sel.onchange = () => {
      launchState.sourceRunId = sel.value || null;
      updateLaunchButton();
    };
    sourceSection.hidden = false;
  }

  updateLaunchButton();
}

function renderStopAfterRail(nodes) {
  const section = $("#launch-stopafter-section");
  const rail = $("#launch-stopafter-rail");
  section.hidden = nodes.length === 0;
  rail.innerHTML = "";
  for (const node of nodes) {
    const btn = document.createElement("button");
    btn.className = "sa-node";
    btn.setAttribute("style", nodeInlineStyle(node));
    btn.textContent = node;
    btn.dataset.node = node;
    updateSaNodeClass(btn, node, nodes);
    btn.addEventListener("click", () => {
      launchState.stopAfter = launchState.stopAfter === node ? null : node;
      rail.querySelectorAll(".sa-node").forEach((b) => updateSaNodeClass(b, b.dataset.node, nodes));
    });
    rail.appendChild(btn);
  }
}

function updateSaNodeClass(btn, node, nodes) {
  // When nothing is selected, treat as "run all" — all nodes appear included
  const cutoffIdx = launchState.stopAfter ? nodes.indexOf(launchState.stopAfter) : nodes.length - 1;
  const nodeIdx = nodes.indexOf(node);
  btn.classList.remove("included", "excluded");
  if (nodeIdx <= cutoffIdx) btn.classList.add("included");
  else btn.classList.add("excluded");
}


async function handleLaunch() {
  if (!launchState.selectedProfile) return;
  const btn = $("#launch-btn");
  const errorEl = $("#launch-error");
  btn.disabled = true;
  btn.textContent = "Launching…";
  errorEl.textContent = "";

  const tag = $("#launch-tag").value.trim();
  const body = {
    profile: launchState.selectedProfile,
    mode: launchState.mode,
    caveman: $("#launch-caveman").checked,
    ...(tag && { tag }),
    ...(launchState.stopAfter && { stopAfter: launchState.stopAfter }),
    ...(launchState.sourceRunId && { runId: launchState.sourceRunId }),
  };

  try {
    const res = await fetch("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "Launch failed");

    // Reset form state
    launchState.selectedProfile = null;
    launchState.stopAfter = null;
    launchState.sourceRunId = null;
    launchState.sourceRunRequired = false;
    renderLaunchProfileGrid();
    $("#launch-stopafter-section").hidden = true;
    $("#launch-source-section").hidden = true;
    $("#launch-tag").value = "";
    updateLaunchButton();

    setTimeout(() => {
      state.manualRunId = data.runId;
      connectRun(data.runId);
      setView("monitor");
    }, 800);
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Launch Run";
  }
}

async function handleResume(run, btn) {
  btn.disabled = true;
  btn.textContent = "Resuming…";
  try {
    const res = await fetch("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id, mode: launchState.mode, caveman: true }),
    });
    if (res.status === 409) {
      btn.disabled = false;
      btn.textContent = "Already running";
      return;
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "Resume failed");
    setTimeout(() => {
      state.manualRunId = data.runId;
      connectRun(data.runId);
      setView("monitor");
    }, 800);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Resume";
    $("#launch-error") && ($("#launch-error").textContent = e.message);
  }
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
    const isIncomplete = run.verdict === "running";
    const isLive = run.alive === true;
    row.innerHTML = `
      <span class="verdict-pill ${run.verdict ?? "running"}">${run.verdict ?? "running"}</span>
      <span class="run-id">${run.id.slice(0, 8)}</span>
      ${run.tag ? `<span class="tag-badge">${escHtml(run.tag)}</span>` : ""}
      <span class="run-profile-badge">${escHtml(run.profile ?? "full")}</span>
      <span class="run-tokens">${fmtTokens(run.totalTokens ?? 0)}</span>
      <span class="run-ts">${fmtTs(run.startTs)}</span>
      ${isLive ? `<span class="live-pill">● Live</span>` : (isIncomplete ? `<button class="resume-btn">Resume</button>` : "")}
    `;
    if (!isLive && isIncomplete) {
      row.querySelector(".resume-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        handleResume(run, this);
      });
    }
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
  if (mode !== "preview") hideNodeInspector();
  if (mode === "preview") {
    initDrawflowCanvas();
    if (state.profiles.content) loadProfileToCanvas(state.profiles.content);
  }
  if (mode === "workers") renderProfileWorkers();
}

async function loadProfiles() {
  const list = $("#profiles-list");
  list.innerHTML = `<div style="color: var(--muted); padding: 12px 14px; font-size: 12px;">Loading…</div>`;
  await ensureDepts();
  renderPalette();
  try {
    const res = await fetch("/api/profiles");
    const profiles = await res.json();
    list.innerHTML = "";
    if (profiles.length === 0) {
      list.innerHTML = `<div style="color: var(--muted); padding: 12px 14px; font-size: 12px;">No profiles</div>`;
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
      list.appendChild(item);
    }
    if (!state.profiles.activeName && profiles.length > 0) {
      loadProfile(profiles[0].name);
    }
  } catch {
    list.innerHTML = `<div style="color: var(--red); padding: 12px 14px; font-size: 12px;">Failed to load</div>`;
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
    if (state.profiles.mode === "preview") { initDrawflowCanvas(); loadProfileToCanvas(data.content); }
    if (state.profiles.mode === "workers") renderProfileWorkers();
    syncPaletteState();
  } catch {
    editor.value = "";
    errEl.textContent = "Failed to load profile.";
  }
}

async function saveProfile() {
  const name = state.profiles.activeName;
  if (!name) return;
  // In canvas mode, pull the latest profile JSON from the canvas state
  const content = state.profiles.mode === "preview"
    ? (canvasToProfile() ?? state.profiles.content ?? "{}")
    : $("#profiles-editor").value;
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

// ---------------------------------------------------------------------------
// Phase 10: Drawflow canvas
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
  "design-spec":             "#c792ea",
  "review-spec":             "#89ddff",
  "runtime-spec":            "#f78c6c",
  "factory-manifest":        "#ffcb6b",
  "build-artifact":          "#58a6ff",
  "event:ship-approved":     "#3fb950",
  "event:ship-rejected":     "#f85149",
  "event:security-approved": "#3fb950",
  "event:security-rejected": "#f85149",
  "event:build-complete":    "#79c0ff",
};

function typeColor(t) { return TYPE_COLORS[t] ?? "var(--muted)"; }

function autoLayoutNodes(nodes) {
  const SPACING_X = 290;
  return nodes.map((n, i) => ({ x: 80 + i * SPACING_X, y: 100 }));
}

function buildNodeHtml(nodeDef, deptInfo, profile) {
  const id      = nodeDef.id ?? "?";
  const color   = state.deptColors[id] ?? "#888";
  const allIns  = (deptInfo?.inputs  ?? []);
  const allOuts = (deptInfo?.outputs ?? []);
  const fileIns  = allIns.filter(t => !t.startsWith("event:"));
  const fileOuts = allOuts.filter(t => !t.startsWith("event:"));
  const evOuts   = allOuts.filter(t => t.startsWith("event:"));

  const budgetAfter = new Set((profile.budgetCheckpoints ?? []).map(b => b.replace(/^after:/, "")));
  const backEdges   = (profile.edges ?? []).filter(e => e.type === "backward" && e.from === id);

  // 1. Skip condition — entry gate, shown before types
  const skipLabel = nodeDef.skipIf      ? "skip if output exists"
                  : nodeDef.skipIfEvent ? `skip if ${escHtml(nodeDef.skipIfEvent)}`
                  : "";
  const skipHtml = skipLabel ? `<div class="cn-skip">${skipLabel}</div>` : "";

  // 2. IN/OUT type grid
  const typeHeader = (fileIns.length > 0 || fileOuts.length > 0)
    ? `<div class="cn-type-row cn-type-header"><div class="cn-type-in cn-col-label">IN</div><div class="cn-type-out cn-col-label">OUT</div></div>`
    : "";
  const maxRows = Math.max(fileIns.length, fileOuts.length);
  let typeRows = "";
  for (let r = 0; r < maxRows; r++) {
    const inT  = fileIns[r]  ? `<span class="cn-type" style="color:${typeColor(fileIns[r])}">${escHtml(fileIns[r])}</span>`  : "";
    const outT = fileOuts[r] ? `<span class="cn-type" style="color:${typeColor(fileOuts[r])}">${escHtml(fileOuts[r])}</span>` : "";
    typeRows += `<div class="cn-type-row"><div class="cn-type-in">${inT}</div><div class="cn-type-out">${outT}</div></div>`;
  }

  // 3. Loop + budget badges — after types, before events
  const midBadges = [
    nodeDef.feedbackLoop ? `<span class="graph-badge loop">↺ loop</span>` : "",
    budgetAfter.has(id)  ? `<span class="graph-badge budget">budget ✓</span>` : "",
  ].filter(Boolean).join("");

  // 4. Completion events
  const eventHtml = evOuts.length
    ? `<div class="cn-events">${evOuts.map(t => {
        const name = t.replace("event:", "");
        return `<span class="cn-event-chip" style="color:${typeColor(t)}">${escHtml(name)}</span>`;
      }).join("")}</div>`
    : "";

  // 5. Back-edge routing
  const backHtml = backEdges.length
    ? `<div class="cn-backs">${backEdges.map(e => `
        <div class="cn-back-rule">
          <div class="cn-back-trigger"><span class="cn-back-on-label">on</span> ${escHtml(e.on ?? "?")}</div>
          <div class="cn-back-action">↺ ${escHtml(e.to ?? "?")}</div>
        </div>`
      ).join("")}</div>`
    : "";

  return `<div class="cn-inner">
  <div class="cn-head">
    <span class="cn-title" style="color:${escHtml(color)}">${escHtml(id.toUpperCase())}</span>
  </div>
  ${skipHtml}
  ${typeRows ? `<div class="cn-types">${typeHeader}${typeRows}</div>` : ""}
  ${midBadges ? `<div class="graph-node-badges">${midBadges}</div>` : ""}
  ${eventHtml}
  ${backHtml}
</div>`;
}

function initDrawflowCanvas() {
  if (state.profiles.drawflow) return;
  const host = $("#profiles-canvas-host");
  if (!host || typeof Drawflow === "undefined") return;

  const df = new Drawflow(host);
  df.reroute = true;
  df.reroute_fix_curvature = true;
  df.force_first_input = false;
  df.start();
  state.profiles.drawflow = df;

  let dirtyTimer = null;
  const markDirty = () => {
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
      const newContent = canvasToProfile();
      if (newContent) {
        state.profiles.content = newContent;
        $("#profiles-editor").value = newContent;
        $("#profiles-save-btn").disabled = false;
        syncPaletteState();
      }
    }, 250);
  };

  df.on("nodeMoved",         markDirty);
  df.on("nodeRemoved",       markDirty);
  df.on("connectionRemoved", markDirty);
  df.on("nodeCreated",       markDirty);

  df.on("nodeSelected",   (numId) => {
    const node = df.getNodeFromId(numId);
    if (node) showNodeInspector(node.name);
  });
  df.on("nodeUnselected", () => hideNodeInspector());

  df.zoom_max = 2;
  df.zoom_min = 0.3;
  df.zoom_value = 0.1;

  const syncBg = () => {
    const x    = df.canvas_x ?? 0;
    const y    = df.canvas_y ?? 0;
    const zoom = df.zoom ?? 1;
    const size = 24 * zoom;
    host.style.backgroundPosition = `${((x % size) + size) % size}px ${((y % size) + size) % size}px`;
    host.style.backgroundSize     = `${size}px ${size}px`;
  };
  df.on("translate", syncBg);
  df.on("zoom",      syncBg);
  host.addEventListener("mousemove", syncBg);

  // Drawflow's built-in zoom_enter only fires on Ctrl+Wheel; add plain-scroll zoom
  host.addEventListener("wheel", (e) => {
    if (e.ctrlKey) return; // let Drawflow handle Ctrl+Wheel natively
    e.preventDefault();
    if (e.deltaY < 0) df.zoom_in();
    else df.zoom_out();
    syncBg();
  }, { passive: false });

  df.on("connectionCreated", ({ output_id, input_id, output_class, input_class }) => {
    const fromNode = df.getNodeFromId(output_id);
    const toNode   = df.getNodeFromId(input_id);
    const depts    = state.profiles.depts;
    const srcOuts  = (depts[fromNode?.name]?.outputs ?? []).filter(t => !t.startsWith("event:"));
    const tgtIns   = depts[toNode?.name]?.inputs ?? [];

    if (srcOuts.length > 0 && tgtIns.length > 0 && !srcOuts.some(t => tgtIns.includes(t))) {
      df.removeSingleConnection(output_id, input_id, output_class, input_class);
      const errEl = $("#profiles-editor-error");
      errEl.textContent = `Incompatible: ${fromNode?.name ?? "?"} outputs don't match ${toNode?.name ?? "?"} inputs`;
      setTimeout(() => { if (errEl.textContent.startsWith("Incompatible")) errEl.textContent = ""; }, 3000);
      return;
    }
    markDirty();
  });
}

function loadProfileToCanvas(jsonText) {
  const emptyEl = $("#profiles-canvas-empty");
  let profile;
  try { profile = JSON.parse(jsonText); } catch {
    if (emptyEl) emptyEl.style.display = "flex";
    return;
  }

  const nodes = profile.nodes ?? [];
  if (nodes.length === 0) {
    if (emptyEl) emptyEl.style.display = "flex";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  const df = state.profiles.drawflow;
  if (!df) return;

  df.clear();
  const layout  = profile.layout ?? {};
  const autoPos = autoLayoutNodes(nodes);
  const depts   = state.profiles.depts;
  const idMap   = {};  // profileNodeId → drawflow numeric id

  nodes.forEach((node, idx) => {
    const pos       = layout[node.id] ?? autoPos[idx];
    const html      = buildNodeHtml(node, depts[node.id], profile);
    const numInputs = (depts[node.id]?.inputs ?? []).length > 0 ? 1 : 0;
    const dfId = df.addNode(
      node.id, numInputs, 1,
      pos.x, pos.y,
      `dept-${node.id}`,
      { profileNodeId: node.id },
      html
    );
    idMap[node.id] = dfId;
  });

  for (const edge of (profile.edges ?? [])) {
    if (edge.type !== "forward") continue;
    const fromId = idMap[edge.from];
    const toId   = idMap[edge.to];
    if (fromId == null || toId == null) continue;
    try { df.addConnection(fromId, toId, "output_1", "input_1"); } catch {}
  }
}

function canvasToProfile() {
  const df = state.profiles.drawflow;
  if (!df) return state.profiles.content;

  let profile;
  try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch { return state.profiles.content; }

  const exported  = df.export();
  const dfNodes   = exported?.drawflow?.Home?.data ?? {};
  const dfIdToName = {};
  for (const [dfId, dfNode] of Object.entries(dfNodes)) dfIdToName[dfId] = dfNode.name;

  // Update layout block from current positions
  profile.layout = {};
  for (const dfNode of Object.values(dfNodes)) {
    profile.layout[dfNode.name] = { x: Math.round(dfNode.pos_x), y: Math.round(dfNode.pos_y) };
  }

  // Sync nodes list: preserve existing node defs, add new, remove deleted
  const canvasNames = new Set(Object.values(dfNodes).map(n => n.name));
  profile.nodes = (profile.nodes ?? []).filter(n => canvasNames.has(n.id));
  const existingIds = new Set((profile.nodes ?? []).map(n => n.id));
  for (const dfNode of Object.values(dfNodes)) {
    if (!existingIds.has(dfNode.name)) {
      profile.nodes.push({
        id: dfNode.name,
        runner: `departments/${dfNode.name}/runner.js`,
        memory: { readWiki: ["design","build","review","security"], readRuns: ["design","build","review","security"], write: dfNode.name },
      });
    }
  }

  // Rebuild forward edges from canvas connections, preserve backward edges
  const backEdges = (profile.edges ?? []).filter(e => e.type === "backward");
  const fwdEdges  = [];
  for (const [, dfNode] of Object.entries(dfNodes)) {
    for (const conn of (dfNode.outputs?.output_1?.connections ?? [])) {
      const toName = dfIdToName[conn.node];
      if (!toName) continue;
      const existing = (profile.edges ?? []).find(e => e.from === dfNode.name && e.to === toName && e.type !== "backward");
      if (existing) {
        fwdEdges.push(existing);
      } else {
        const depts   = state.profiles.depts;
        const srcOuts = depts[dfNode.name]?.outputs ?? [];
        const tgtIns  = depts[toName]?.inputs ?? [];
        const carries = srcOuts.filter(t => tgtIns.includes(t));
        fwdEdges.push({ from: dfNode.name, to: toName, type: "forward", ...(carries.length ? { carries } : {}) });
      }
    }
  }
  profile.edges = [...fwdEdges, ...backEdges];

  return JSON.stringify(profile, null, 2);
}

function renderPalette() {
  const palette = $("#profiles-palette");
  if (!palette) return;
  const depts = state.profiles.depts;
  palette.innerHTML = "";
  for (const [id, info] of Object.entries(depts)) {
    const chip = document.createElement("div");
    chip.className = "palette-dept";
    chip.dataset.deptId = id;
    chip.textContent = id;
    const color = info.color ?? "#888";
    chip.style.borderColor = color;
    chip.style.color = color;
    chip.title = `Add ${id} node to canvas`;
    chip.addEventListener("click", () => addDeptNodeToCanvas(id));
    palette.appendChild(chip);
  }
}

function syncPaletteState() {
  const df = state.profiles.drawflow;
  if (!df) return;
  const exported = df.export();
  const dfNodes  = exported?.drawflow?.Home?.data ?? {};
  const onCanvas = new Set(Object.values(dfNodes).map(n => n.name));
  $$(".palette-dept").forEach(chip => {
    chip.classList.toggle("already-added", onCanvas.has(chip.dataset.deptId));
  });
}

function addDeptNodeToCanvas(deptId) {
  const df = state.profiles.drawflow;
  if (!df) return;

  let profile;
  try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch { profile = {}; }

  // Find an open x position
  const exported  = df.export();
  const dfNodes   = exported?.drawflow?.Home?.data ?? {};
  const maxX      = Object.values(dfNodes).reduce((m, n) => Math.max(m, n.pos_x + 200), 60);
  const html = buildNodeHtml(
    { id: deptId, runner: `departments/${deptId}/runner.js` },
    state.profiles.depts[deptId],
    profile
  );
  const numInputs = (state.profiles.depts[deptId]?.inputs ?? []).length > 0 ? 1 : 0;
  df.addNode(deptId, numInputs, 1, maxX, 100, `dept-${deptId}`, { profileNodeId: deptId }, html);
}

// ---------------------------------------------------------------------------
// Node inspector
// ---------------------------------------------------------------------------

function showNodeInspector(deptName) {
  const deptInfo = state.profiles.depts[deptName];
  if (!deptInfo) return;

  let profile;
  try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch { profile = {}; }

  const color      = state.deptColors[deptName] ?? "#888";
  const hasBudget  = (profile.budgetCheckpoints ?? []).includes(`after:${deptName}`);

  $("#inspector-dept-name").textContent = deptName.toUpperCase();
  $("#inspector-dept-name").style.color = color;
  $("#inspector-description").textContent = deptInfo.description ?? "";
  $("#inspector-budget-check").checked = hasBudget;

  const slots       = deptInfo.slots ?? [];
  const slotsSection = $("#inspector-slots-section");
  const slotsEl     = $("#inspector-slots");
  if (slots.length > 0) {
    slotsEl.innerHTML = slots.map(s => `
      <div class="inspector-slot">
        <span class="inspector-slot-name">${escHtml(s.name)}</span>
        <span class="inspector-slot-type">${escHtml(s.description ?? "")}</span>
      </div>`).join("");
    slotsSection.style.display = "flex";
  } else {
    slotsSection.style.display = "none";
  }

  const inspector = $("#profiles-inspector");
  inspector.classList.add("visible");
  inspector.dataset.deptName = deptName;
}

function hideNodeInspector() {
  const inspector = $("#profiles-inspector");
  inspector.classList.remove("visible");
  inspector.dataset.deptName = "";
}

// ---------------------------------------------------------------------------
// Profile Workers roster
// ---------------------------------------------------------------------------

function updateWorkerAssignment(slotKey, workerId, schemaDefault) {
  let profile;
  try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch { return; }
  if (!profile.workerAssignments) profile.workerAssignments = {};
  if (workerId === schemaDefault) {
    delete profile.workerAssignments[slotKey];
  } else {
    profile.workerAssignments[slotKey] = workerId;
  }
  if (Object.keys(profile.workerAssignments).length === 0) delete profile.workerAssignments;
  const newContent = JSON.stringify(profile, null, 2);
  state.profiles.content = newContent;
  $("#profiles-editor").value = newContent;
  $("#profiles-save-btn").disabled = false;
}

async function renderProfileWorkers() {
  const pane = $("#profiles-workers-pane");
  pane.innerHTML = `<div style="color: var(--muted); font-size: 12px; padding: 4px 0;">Loading…</div>`;

  try {
    if (!state.workers.list.length) {
      state.workers.list = await fetch("/api/workers").then((r) => r.json());
    }
    if (!state.workers.slots.length) {
      state.workers.slots = await fetch("/api/workers/slots").then((r) => r.json());
    }
  } catch {
    pane.innerHTML = `<div style="color: var(--red); font-size: 12px;">Failed to load workers data.</div>`;
    return;
  }

  let profile;
  try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch {
    pane.innerHTML = `<div style="color: var(--red); font-size: 12px;">Invalid profile JSON — switch to Code tab to fix.</div>`;
    return;
  }

  const nodes = profile.nodes ?? [];
  if (!nodes.length) {
    pane.innerHTML = `<div style="color: var(--muted); font-size: 12px; padding: 4px 0;">No nodes in this profile.</div>`;
    return;
  }

  const assignments  = profile.workerAssignments ?? {};
  const workersList  = state.workers.list;
  const slotsAll     = state.workers.slots;

  pane.innerHTML = "";
  let anySlotsFound = false;

  for (const node of nodes) {
    const deptSlots = slotsAll.filter((s) => s.department === node.id);
    if (!deptSlots.length) continue;
    anySlotsFound = true;

    const section = document.createElement("div");
    section.className = "slot-dept-section";

    const label = document.createElement("div");
    label.className = "slot-dept-label";
    const deptColor = state.deptColors[(node.id ?? "").toLowerCase()];
    if (deptColor) label.style.color = deptColor;
    label.textContent = node.id;
    section.appendChild(label);

    for (const slot of deptSlots) {
      const slotKey         = slot.key;
      const currentAssign   = assignments[slotKey] ?? slot.default;
      const matchingWorkers = workersList.filter((w) => w.department === node.id && w.slotType === slot.id);

      const row = document.createElement("div");
      row.className = "slot-row";

      const info = document.createElement("div");
      info.className = "slot-info";
      info.innerHTML = `<div class="slot-key">${escHtml(slotKey)}</div><div class="slot-desc">${escHtml(slot.description ?? "")}</div>`;
      row.appendChild(info);

      if (currentAssign !== slot.default) {
        const badge = document.createElement("span");
        badge.className = "slot-custom-badge";
        badge.textContent = "custom";
        row.appendChild(badge);
      }

      const select = document.createElement("select");
      select.className = "slot-select";

      if (!matchingWorkers.length) {
        const opt = document.createElement("option");
        opt.textContent = "(no workers for this slot)";
        opt.disabled = true;
        select.appendChild(opt);
        select.disabled = true;
      } else {
        for (const w of matchingWorkers) {
          const opt = document.createElement("option");
          opt.value = w.id;
          opt.textContent = w.id === slot.default ? `${w.name} (default)` : w.name;
          if (w.id === currentAssign) opt.selected = true;
          select.appendChild(opt);
        }
      }

      select.addEventListener("change", () => {
        updateWorkerAssignment(slotKey, select.value, slot.default);
        const badge = row.querySelector(".slot-custom-badge");
        if (select.value !== slot.default) {
          if (!badge) {
            const b = document.createElement("span");
            b.className = "slot-custom-badge";
            b.textContent = "custom";
            row.insertBefore(b, select);
          }
        } else if (badge) {
          badge.remove();
        }
      });

      row.appendChild(select);
      section.appendChild(row);
    }

    pane.appendChild(section);
  }

  if (!anySlotsFound) {
    pane.innerHTML = `<div style="color: var(--muted); font-size: 12px; padding: 4px 0;">No configurable slots found for this profile's departments.</div>`;
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
      state.memory.editMode = false;
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
      state.memory.editMode = false;
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
  const rawWiki = deptData?.wiki ?? "";

  if (!rawWiki && !state.memory.editMode) {
    content.className = "";
    const label = dept.charAt(0).toUpperCase() + dept.slice(1);
    content.innerHTML = `
      <div class="empty-state">
        <span>No wiki entries yet for ${escHtml(label)}</span>
        <span class="hint">Craft knowledge accumulates here after completed runs. The factory learns over time.</span>
        <button class="mem-edit-btn" style="margin-top:12px;">Edit</button>
      </div>`;
    content.querySelector(".mem-edit-btn").addEventListener("click", () => {
      state.memory.editMode = true;
      renderMemoryWiki(dept);
    });
    return;
  }

  if (state.memory.editMode) {
    content.className = "mem-wiki-edit";
    content.innerHTML = `
      <div class="mem-edit-toolbar">
        <button class="mem-save-btn">Save</button>
        <button class="mem-cancel-btn">Cancel</button>
        <span class="mem-save-status"></span>
      </div>
      <textarea class="mem-wiki-editor" spellcheck="false">${escHtml(rawWiki)}</textarea>`;
    content.querySelector(".mem-cancel-btn").addEventListener("click", () => {
      state.memory.editMode = false;
      renderMemoryWiki(dept);
    });
    content.querySelector(".mem-save-btn").addEventListener("click", async () => {
      const text = content.querySelector(".mem-wiki-editor").value;
      const status = content.querySelector(".mem-save-status");
      status.textContent = "Saving…";
      try {
        const res = await fetch(`/api/memory/${dept}/wiki`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
        if (!res.ok) throw new Error();
        if (state.memory.data?.data?.[dept]) state.memory.data.data[dept].wiki = text;
        state.memory.editMode = false;
        renderMemoryWiki(dept);
      } catch {
        status.textContent = "Save failed.";
        status.style.color = "var(--red)";
      }
    });
    return;
  }

  content.className = "mem-wiki";
  content.innerHTML = `
    <div class="mem-edit-toolbar">
      <button class="mem-edit-btn">Edit</button>
    </div>
    <div class="mem-wiki-body">${marked.parse(rawWiki)}</div>`;
  content.querySelector(".mem-edit-btn").addEventListener("click", () => {
    state.memory.editMode = true;
    renderMemoryWiki(dept);
  });
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
      <button class="run-record-delete" title="Delete this record">✕</button>
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

    header.addEventListener("click", (e) => {
      if (e.target.closest(".run-record-delete")) return;
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      header.querySelector(".run-record-toggle").textContent = open ? "▶" : "▼";
    });

    header.querySelector(".run-record-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      const runId = record.runId;
      if (!runId) return;
      try {
        const res = await fetch(`/api/memory/${dept}/runs/${runId}`, { method: "DELETE" });
        if (!res.ok) throw new Error();
        const deptData = state.memory.data?.data?.[dept];
        if (deptData) deptData.runs = deptData.runs.filter((r) => (r.record ?? r).runId !== runId);
        el.remove();
      } catch {
        // silently ignore — entry may not exist
      }
    });

    el.appendChild(header);
    el.appendChild(body);
    content.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Factory Org
// ---------------------------------------------------------------------------

async function loadStaffData() {
  const sidebar = $("#org-sidebar");
  sidebar.innerHTML = `<div style="color:var(--muted);padding:12px 14px;font-size:12px;">Loading…</div>`;
  try {
    const [rolesRes, workersRes] = await Promise.all([fetch("/api/roles"), fetch("/api/workers")]);
    state.org.roles = await rolesRes.json();
    state.workers.list = await workersRes.json();
  } catch {
    sidebar.innerHTML = `<div style="color:var(--red);padding:12px 14px;font-size:12px;">Failed to load</div>`;
    return;
  }
  renderStaffSidebar();
  if (!state.org.activeRoleId && !state.workers.activeId && state.org.roles[0]) {
    selectOrgRole(state.org.roles[0].id);
  } else if (state.org.activeRoleId) {
    selectOrgRole(state.org.activeRoleId);
  } else if (state.workers.activeId) {
    const w = state.workers.list.find((x) => x.id === state.workers.activeId);
    if (w) selectWorker(w);
  }
  await checkHrSession();
}

function renderStaffSidebar() {
  const sidebar = $("#org-sidebar");
  sidebar.innerHTML = "";

  // Brain Roles section
  const rolesHeader = document.createElement("div");
  rolesHeader.className = "staff-section-header";
  rolesHeader.textContent = "Brain Roles";
  sidebar.appendChild(rolesHeader);

  for (const role of state.org.roles) {
    const item = document.createElement("div");
    item.className = "org-role-item" + (role.id === state.org.activeRoleId ? " active" : "");
    item.dataset.roleId = role.id;
    const statusClass = role.hasBrain ? "org-status-ready" : "org-status-missing";
    const statusLabel = role.hasBrain ? "ready" : "needs interview";
    item.innerHTML = `
      <span class="org-role-name">${escHtml(role.name)}</span>
      <span class="org-role-status ${statusClass}">${statusLabel}</span>
    `;
    item.addEventListener("click", () => selectOrgRole(role.id));
    sidebar.appendChild(item);
  }

  const newRoleBtn = document.createElement("button");
  newRoleBtn.className = "org-new-role-btn";
  newRoleBtn.textContent = state.org.session ? "Session in progress…" : "+ New Role";
  newRoleBtn.disabled = !!state.org.session;
  newRoleBtn.addEventListener("click", startCreateRole);
  sidebar.appendChild(newRoleBtn);

  // Workers section
  const workersHeader = document.createElement("div");
  workersHeader.className = "staff-section-header";
  workersHeader.textContent = "Workers";
  sidebar.appendChild(workersHeader);

  const groups = {};
  for (const w of state.workers.list) {
    const key = w.department ? `${w.department}.${w.slotType}` : (w.slotType ?? "other");
    if (!groups[key]) groups[key] = [];
    groups[key].push(w);
  }

  if (!state.workers.list.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--muted);padding:8px 14px;font-size:12px;";
    empty.textContent = "No workers yet.";
    sidebar.appendChild(empty);
  } else {
    for (const [key, group] of Object.entries(groups)) {
      const label = document.createElement("div");
      label.className = "workers-slot-group";
      label.textContent = key;
      sidebar.appendChild(label);
      for (const w of group) {
        const item = document.createElement("div");
        item.className = "worker-item" + (w.id === state.workers.activeId ? " active" : "");
        item.innerHTML = `<span class="worker-item-name">${escHtml(w.name)}</span><span class="worker-item-slot">${escHtml(w.slotType ?? "")}</span>`;
        item.addEventListener("click", () => selectWorker(w));
        sidebar.appendChild(item);
      }
    }
  }
}

async function startCreateRole() {
  const btn = $(".org-new-role-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
  try {
    const res = await fetch("/api/org/roles/create", { method: "POST" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "Failed to start HR session");
    await checkHrSession();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "+ New Role"; }
    alert(`HR error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// HR session management
// ---------------------------------------------------------------------------

async function checkHrSession() {
  try {
    const res  = await fetch("/api/org/session");
    const data = await res.json();
    if (data.active) {
      openHrSession(data);
    } else if (state.org.session) {
      closeHrSession(false); // session ended externally
    }
  } catch {}
}

function openHrSession(data) {
  // If already open for same session, just reconnect if needed
  if (state.org.session?.runId === data.runId && state.org.session?.es) return;

  // Close any previous session stream
  if (state.org.session?.es) state.org.session.es.close();

  const typeLabel = data.type === "create-role" ? "New Role Design" : `Brain Interview`;
  const roleLabel = data.roleId ? ` — ${data.roleId}` : "";
  $("#org-hr-title").textContent = typeLabel + roleLabel;

  // Render initial transcript
  if (data.transcript) {
    renderHrTranscript(data.transcript);
  } else {
    $("#org-hr-transcript").innerHTML = `<div class="org-hr-thinking">Starting session…</div>`;
  }

  // Show initial pending input or thinking state
  if (data.pendingInput) {
    showHrInput(data.pendingInput);
  } else {
    setHrStatus("thinking");
  }

  // Switch to HR mode
  setOrgTab("hr");

  // Disable navigation buttons
  renderStaffSidebar();
  const interviewBtn = $("#org-interview-btn");
  interviewBtn.textContent = "Session in progress…";
  interviewBtn.disabled = true;

  // Connect SSE stream
  const es = new EventSource(`/api/hr-session/${data.runId}/stream`);
  state.org.session = { runId: data.runId, type: data.type, roleId: data.roleId, es };

  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      if (msg.transcript) renderHrTranscript(msg.transcript);
      if (msg.pendingInput) showHrInput(msg.pendingInput);
      else setHrStatus("thinking");
    } else if (msg.type === "transcript") {
      renderHrTranscript(msg.content);
    } else if (msg.type === "pending-input") {
      showHrInput({ prompt: msg.prompt, type: msg.inputType, options: msg.options });
    } else if (msg.type === "input-cleared") {
      hideHrInput();
      setHrStatus("thinking");
    } else if (msg.type === "session-complete") {
      es.close();
      state.org.session = null;
      closeHrSession(true);
    }
  };
  es.onerror = () => {};
}

async function closeHrSession(reload) {
  if (state.org.session?.es) state.org.session.es.close();
  state.org.session = null;
  hideHrInput();
  setOrgTab("brain");
  if (reload) {
    await loadStaffData();
  } else {
    renderStaffSidebar();
    const btn = $("#org-interview-btn");
    if (state.org.activeRoleId) {
      const role = state.org.roles?.find((r) => r.id === state.org.activeRoleId);
      if (role) { btn.textContent = role.hasBrain ? "Re-interview" : "Run Interview"; btn.disabled = false; }
    } else {
      btn.disabled = true;
    }
  }
}

function renderHrTranscript(content) {
  const pane = $("#org-hr-transcript");
  pane.innerHTML = marked.parse(content);
  pane.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
  pane.scrollTop = pane.scrollHeight;
}

function setHrStatus(status) {
  const el = $("#org-hr-status");
  el.textContent = status === "thinking" ? "thinking…" : status === "waiting" ? "waiting for you" : "";
  el.className = `org-hr-status org-hr-status-${status}`;
}

function showHrInput(input) {
  setHrStatus("waiting");
  const area = $("#org-hr-input-area");
  area.style.display = "flex";

  const promptEl = $("#org-hr-prompt");
  promptEl.innerHTML = "";
  if (input.prompt) {
    promptEl.textContent = input.prompt;
    promptEl.hidden = false;
  } else {
    promptEl.hidden = true;
  }

  const optionsEl = $("#org-hr-options");
  optionsEl.innerHTML = "";
  if (input.options?.length > 0) {
    for (const opt of input.options) {
      const btn = document.createElement("button");
      btn.className = "org-hr-option-btn";
      btn.textContent = opt;
      btn.addEventListener("click", () => submitHrResponse(opt));
      optionsEl.appendChild(btn);
    }
  }

  const field = $("#org-hr-field");
  const isTextOnly = input.type === "options" && !(input.type === "hybrid");
  field.hidden = isTextOnly;
  if (!isTextOnly) { field.focus(); }
}

function hideHrInput() {
  $("#org-hr-input-area").style.display = "none";
  $("#org-hr-field").value = "";
  $("#org-hr-options").innerHTML = "";
}

async function submitHrResponse(text) {
  const val = (text ?? $("#org-hr-field").value).trim();
  if (!val || !state.org.session) return;
  hideHrInput();
  setHrStatus("thinking");
  try {
    await fetch(`/api/hr-session/${state.org.session.runId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: val }),
    });
  } catch {}
}

function selectOrgRole(roleId) {
  state.org.activeRoleId = roleId;
  state.workers.activeId = null;
  renderStaffSidebar();
  const role = state.org.roles?.find((r) => r.id === roleId);
  if (!role) return;

  const btn = $("#org-interview-btn");
  if (state.org.session) {
    btn.textContent = "Session in progress…";
    btn.disabled = true;
  } else {
    btn.textContent = role.hasBrain ? "Re-interview" : "Run Interview";
    btn.disabled = false;
  }

  renderOrgBrain(role);
  setOrgTab("brain");
}

function selectWorker(worker) {
  state.workers.activeId = worker.id;
  state.org.activeRoleId = null;
  renderStaffSidebar();
  const btn = $("#org-interview-btn");
  btn.disabled = true;
  btn.textContent = state.org.session ? "Session in progress…" : "Run Interview";
  renderWorkerDetail(worker);
  setOrgTab("brain");
}

function setOrgTab(tab) {
  $("#org-main").className = `org-mode-${tab}`;
}

function renderOrgBrain(role) {
  const pane = $("#org-brain-pane");
  if (role.hasBrain && role.brainContent) {
    pane.className = "mem-wiki";
    pane.innerHTML = marked.parse(role.brainContent);
    pane.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
  } else {
    pane.className = "";
    pane.innerHTML = `
      <div class="empty-state">
        <span>No brain yet for ${escHtml(role.name)}</span>
        <span class="hint">Run an interview to build this role's decision-making profile.</span>
      </div>`;
  }
}


function renderWorkerDetail(worker) {
  const pane = $("#org-brain-pane");
  const prompt = worker.promptContent ?? "(no prompt)";
  pane.className = "";
  pane.innerHTML = `
    <div class="worker-detail-header">
      <span class="worker-detail-name">${escHtml(worker.name)}</span>
      <span class="worker-slot-badge">${worker.department ? escHtml(worker.department) + "." : ""}${escHtml(worker.slotType ?? "")}</span>
    </div>
    <div class="worker-detail-desc">${escHtml(worker.description || "")}</div>
    <div class="worker-prompt-label">System Prompt</div>
    <div class="worker-prompt-content">${escHtml(prompt)}</div>
  `;
}

// ---------------------------------------------------------------------------
// Org Charts view
// ---------------------------------------------------------------------------

async function loadOrgChartsData(profileName) {
  const sidebar = $("#orgcharts-sidebar");
  sidebar.innerHTML = `<div style="color:var(--muted);padding:12px 14px;font-size:12px;">Loading…</div>`;
  try {
    const qs = profileName ? `?profile=${encodeURIComponent(profileName)}` : "";
    const res  = await fetch(`/api/org${qs}`);
    const data = await res.json();
    state.orgCharts.profiles     = data.profiles ?? [];
    state.orgCharts.activeProfile = data.activeProfile;
    state.orgCharts.nodes        = data.nodes ?? [];
  } catch {
    sidebar.innerHTML = `<div style="color:var(--red);padding:12px 14px;font-size:12px;">Failed to load</div>`;
    return;
  }
  renderOrgChartsSidebar();
  renderOrgChartsTree();
}

function renderOrgChartsSidebar() {
  const sidebar = $("#orgcharts-sidebar");
  sidebar.innerHTML = "";
  for (const p of state.orgCharts.profiles) {
    const item = document.createElement("div");
    item.className = "orgcharts-profile-item" + (p.name === state.orgCharts.activeProfile ? " active" : "");
    item.dataset.profile = p.name;
    item.innerHTML = `
      <span class="orgcharts-profile-name">${escHtml(p.name)}</span>
      ${p.description ? `<span class="orgcharts-profile-desc">${escHtml(p.description)}</span>` : ""}
    `;
    item.addEventListener("click", () => loadOrgChartsData(p.name));
    sidebar.appendChild(item);
  }
}

function renderOrgChartsTree() {
  const main  = $("#orgcharts-main");
  const nodes = state.orgCharts.nodes ?? [];

  if (nodes.length === 0) {
    main.innerHTML = `<div class="empty-state"><span>No roles in this profile</span><span class="hint">Add roles via Factory Roles to populate the org chart.</span></div>`;
    return;
  }

  const childrenOf = {};
  const allIds = new Set(nodes.map((n) => n.roleId));
  for (const node of nodes) {
    const parent = node.escalatesTo ?? "__human__";
    if (!childrenOf[parent]) childrenOf[parent] = [];
    childrenOf[parent].push(node);
  }

  function renderNode(node) {
    const statusClass = node.hasBrain ? "org-node-ready" : "org-node-missing";
    const children    = childrenOf[node.roleId] ?? [];
    const card = `<div class="org-node-card ${statusClass}" data-role-id="${escHtml(node.role.id)}">
      <span class="org-node-name">${escHtml(node.role.name)}</span>
      <span class="org-node-dot"></span>
    </div>`;
    if (children.length === 0) return `<li>${card}</li>`;
    return `<li>${card}<ul>${children.map(renderNode).join("")}</ul></li>`;
  }

  const roots = nodes.filter((n) => !n.escalatesTo || !allIds.has(n.escalatesTo));
  const humanCard = `<div class="org-node-card org-node-human"><span class="org-node-name">Human</span><span class="org-node-dot"></span></div>`;

  main.innerHTML = `<div class="org-chart"><ul><li>${humanCard}<ul>${roots.map(renderNode).join("")}</ul></li></ul></div>`;
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
  document.addEventListener("mouseup", () => { dragStart = null; inspectorDrag = null; });

  // Inspector panel drag-to-resize
  let inspectorDrag = null;
  $("#inspector-resize").addEventListener("mousedown", (e) => {
    inspectorDrag = { x: e.clientX, w: $("#profiles-inspector").offsetWidth };
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!inspectorDrag) return;
    const newW = Math.max(180, Math.min(520, inspectorDrag.w + (inspectorDrag.x - e.clientX)));
    $("#profiles-inspector").style.width = newW + "px";
  });

  // Profiles
  $$(".profiles-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setProfilesMode(btn.dataset.mode));
  });
  $("#profiles-save-btn").addEventListener("click", saveProfile);
  $("#profiles-editor").addEventListener("input", () => {
    state.profiles.content = $("#profiles-editor").value;
  });

  $("#inspector-close").addEventListener("click", () => {
    hideNodeInspector();
    const df = state.profiles.drawflow;
    if (df && df.node_selected) {
      df.node_selected.classList.remove("selected");
      df.node_selected = null;
    }
  });

  $("#inspector-budget-check").addEventListener("change", (e) => {
    const deptName = $("#profiles-inspector").dataset.deptName;
    if (!deptName) return;

    let profile;
    try { profile = JSON.parse(state.profiles.content ?? "{}"); } catch { return; }

    const checkpoints = profile.budgetCheckpoints ?? [];
    const key = `after:${deptName}`;
    if (e.target.checked) {
      if (!checkpoints.includes(key)) checkpoints.push(key);
    } else {
      const idx = checkpoints.indexOf(key);
      if (idx !== -1) checkpoints.splice(idx, 1);
    }
    profile.budgetCheckpoints = checkpoints.length > 0 ? checkpoints : undefined;
    if (!profile.budgetCheckpoints) delete profile.budgetCheckpoints;

    state.profiles.content = JSON.stringify(profile, null, 2);
    $("#profiles-editor").value = state.profiles.content;
    $("#profiles-save-btn").disabled = false;

    // Re-render the affected node's content from the updated profile
    const df = state.profiles.drawflow;
    if (df) {
      const updatedProfile = JSON.parse(state.profiles.content);
      const nodeDef = (updatedProfile.nodes ?? []).find(n => n.id === deptName);
      if (nodeDef) {
        const exported = df.export();
        for (const [numId, node] of Object.entries(exported?.drawflow?.Home?.data ?? {})) {
          if (node.name !== deptName) continue;
          const contentEl = document.querySelector(`#node-${numId} .drawflow_content_node`);
          if (contentEl) {
            contentEl.innerHTML = buildNodeHtml(nodeDef, state.profiles.depts[deptName], updatedProfile);
          }
          break;
        }
      }
    }
  });

  $("#memory-refresh-btn").addEventListener("click", loadMemoryData);

  // Factory Staff
  $("#staff-refresh-btn").addEventListener("click", () => loadStaffData());

  // Org Charts
  $("#orgcharts-refresh-btn").addEventListener("click", () => loadOrgChartsData(state.orgCharts.activeProfile));
  $("#org-interview-btn").addEventListener("click", async () => {
    const roleId = state.org.activeRoleId;
    if (!roleId || state.org.session) return;
    const btn = $("#org-interview-btn");
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const res = await fetch(`/api/org/${roleId}/interview`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Failed to start interview");
      await checkHrSession();
    } catch (e) {
      btn.textContent = prevText;
      btn.disabled = state.org.session != null;
      alert(`Interview error: ${e.message}`);
    }
  });

  // HR session pane
  $("#org-hr-end-btn").addEventListener("click", async () => {
    if (!confirm("End the HR session? Any unsaved progress will be lost.")) return;
    await fetch("/api/org/session", { method: "DELETE" });
    closeHrSession(false);
  });

  $("#org-hr-send").addEventListener("click", () => submitHrResponse());

  $("#org-hr-field").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitHrResponse(); }
  });

  $("#staff-new-worker-btn").addEventListener("click", async () => {
    const btn = $("#staff-new-worker-btn");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const res = await fetch("/api/workers/create", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Failed to start worker design session.");
        return;
      }
      await checkHrSession();
    } finally {
      btn.disabled = false;
      btn.textContent = "+ New Worker";
    }
  });

  // Collapsible sections
  $$(".section-title").forEach((title) => {
    title.addEventListener("click", () => title.closest(".section").classList.toggle("collapsed"));
  });

  setView("launch");
  detectActiveRun();
  setInterval(detectActiveRun, 3000);
});

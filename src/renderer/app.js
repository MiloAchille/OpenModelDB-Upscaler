const state = {
  inputPath: null,
  outputPath: null,
  beforeUrl: null,
  afterUrl: null,
  mode: "factor",
  factor: 4,
  longest: 2048,
  format: "png",
  tile: 256,
  models: [],
  selectedModel: null,
  busy: false,
  runtimeReady: false,
  runtimeInstalling: false,
  split: 0.5,
  zoom: 1,
  panX: 0,
  panY: 0,
  hasResult: false,
};

const $ = (sel) => document.querySelector(sel);

function appendLog(line) {
  const text = String(line || "").trim();
  if (!text) return;
  // Ignore noisy torch future-warnings that aren't real failures.
  if (/torch\.meshgrid|UserWarning:|Triggered internally at/i.test(text)) return;
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  const entry = `[${stamp}] ${text}\n`;
  for (const id of ["#log", "#runtime-log"]) {
    const el = $(id);
    if (!el) continue;
    el.textContent += entry;
    el.scrollTop = el.scrollHeight;
  }
}

function clearLogs() {
  for (const id of ["#log", "#runtime-log"]) {
    const el = $(id);
    if (el) el.textContent = "";
  }
}

function setProgress(pct, label) {
  if (typeof pct === "number" && !Number.isNaN(pct)) {
    $("#progress-fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  if (label) $("#progress-label").textContent = label;
}

function basename(p) {
  return String(p || "").split(/[/\\]/).pop();
}

function stem(p) {
  return basename(p).replace(/\.[^.]+$/, "");
}

function syncModeUi() {
  document.querySelectorAll(".seg").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
  $("#factor-row").classList.toggle("hidden", state.mode !== "factor");
  $("#longest-row").classList.toggle("hidden", state.mode !== "longest");
}

function syncChipUi() {
  document.querySelectorAll("#factor-chips .chip").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.factor) === Number(state.factor));
  });
  document.querySelectorAll("#longest-chips .chip").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.longest) === Number(state.longest));
  });
  const custom = $("#longest-custom");
  if (custom && String(custom.value) !== String(state.longest)) {
    custom.value = String(state.longest);
  }
}

function clampLongest(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return state.longest || 2048;
  return Math.max(64, Math.min(16384, v));
}

function updateViewerChrome() {
  const empty = !state.beforeUrl;
  const viewer = $("#viewer");
  viewer.classList.toggle("has-image", !empty);
  $("#viewer-empty").hidden = !empty;
  $("#compare-world").hidden = empty;
  $("#compare-chrome").hidden = empty;
  $("#slider").hidden = !state.hasResult;
  $("#pill-after").hidden = !state.hasResult;
  $("#pill-before").textContent = state.hasResult ? "before" : "source";
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
  if (!state.hasResult) {
    state.split = 1;
  }
  applySplit();
  applyTransform();
}

function applySplit() {
  const pct = Math.max(0, Math.min(1, state.split)) * 100;
  $("#before-clip").style.width = `${pct}%`;
  $("#slider").style.left = `${pct}%`;
}

function applyTransform() {
  const world = $("#compare-world");
  world.style.transform = `translate(calc(-50% + ${state.panX}px), calc(-50% + ${state.panY}px)) scale(${state.zoom})`;
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitWorldToImages() {
  const before = $("#img-before");
  const after = $("#img-after");
  const src =
    state.hasResult && after.naturalWidth
      ? after
      : before.naturalWidth
        ? before
        : null;
  if (!src) return;
  const world = $("#compare-world");
  world.style.width = `${src.naturalWidth}px`;
  world.style.height = `${src.naturalHeight}px`;
  before.style.width = `${src.naturalWidth}px`;
  before.style.height = `${src.naturalHeight}px`;
  after.style.width = `${src.naturalWidth}px`;
  after.style.height = `${src.naturalHeight}px`;
}

async function showBefore(dataUrl) {
  state.beforeUrl = dataUrl;
  state.afterUrl = null;
  state.hasResult = false;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.split = 1;
  const before = $("#img-before");
  const after = $("#img-after");
  after.removeAttribute("src");
  after.hidden = true;
  before.hidden = false;
  before.src = dataUrl;
  await before.decode().catch(() => {});
  fitWorldToImages();
  updateViewerChrome();
  $("#image-meta").textContent = "scroll to zoom · drag to pan";
}

async function showAfter(dataUrl) {
  state.afterUrl = dataUrl;
  state.hasResult = true;
  state.split = 0.5;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  const after = $("#img-after");
  after.hidden = false;
  after.src = dataUrl;
  await after.decode().catch(() => {});
  fitWorldToImages();
  updateViewerChrome();
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function refreshModels() {
  state.models = await window.api.listModels();
  const select = $("#model-select");
  select.innerHTML = "";
  if (!state.models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no models found in /models";
    select.appendChild(opt);
    state.selectedModel = null;
    $("#btn-upscale").disabled = true;
    return;
  }
  for (const m of state.models) {
    if (m.suspicious) continue;
    const opt = document.createElement("option");
    opt.value = m.path;
    opt.textContent = `${m.name}${m.builtin ? "" : " (downloaded)"}`;
    select.appendChild(opt);
  }
  const usable = state.models.filter((m) => !m.suspicious);
  if (!usable.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no valid local models (check Models tab)";
    select.appendChild(opt);
    state.selectedModel = null;
    $("#btn-upscale").disabled = true;
    return;
  }
  const preferred =
    usable.find((m) => m.path === state.selectedModel) ||
    usable.find((m) => /4xLSDIRDAT/i.test(m.name)) ||
    usable.find((m) => m.builtin) ||
    usable[0];
  state.selectedModel = preferred.path;
  select.value = preferred.path;
  $("#btn-upscale").disabled = !state.inputPath || !state.selectedModel;
}

async function refreshLibrary() {
  const models = await window.api.listModels();
  state.models = models;
  const list = $("#library-list");
  list.innerHTML = "";
  $("#library-status").textContent = models.length
    ? `${models.length} model${models.length === 1 ? "" : "s"} installed`
    : "no models yet — import one or download from openmodeldb";

  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = "no local models found";
    list.appendChild(empty);
    await refreshModels();
    return;
  }

  for (const m of models) {
    const row = document.createElement("article");
    row.className = "library-row";
    if (m.path === state.selectedModel) row.classList.add("active");

    const meta = document.createElement("div");
    meta.className = "library-meta";
    const title = document.createElement("h3");
    title.textContent = m.name;
    const info = document.createElement("p");
    const badge = document.createElement("span");
    badge.className = "tag";
    badge.textContent = m.builtin ? "bundled" : "user";
    info.appendChild(badge);
    if (m.suspicious) {
      const bad = document.createElement("span");
      bad.className = "tag bad";
      bad.textContent = "corrupt / incomplete";
      info.appendChild(bad);
    } else {
      const ok = document.createElement("span");
      ok.className = "tag ok";
      ok.textContent = "offline ready";
      info.appendChild(ok);
    }
    info.appendChild(document.createTextNode(` ${formatBytes(m.size)}`));
    meta.append(title, info);

    const pathLine = document.createElement("p");
    pathLine.textContent = m.path;
    meta.appendChild(pathLine);
    if (m.suspicious) {
      const warn = document.createElement("p");
      warn.className = "warn";
      warn.textContent =
        "This file looks like a failed download (webpage/HTML). Delete it and download again, or import the real .pth manually.";
      meta.appendChild(warn);
    }
    const actions = document.createElement("div");
    actions.className = "library-row-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn primary";
    useBtn.textContent = m.path === state.selectedModel ? "selected" : "use";
    useBtn.disabled = m.path === state.selectedModel;
    useBtn.addEventListener("click", async () => {
      state.selectedModel = m.path;
      await window.api.setSettings({ lastModel: m.path });
      await refreshModels();
      await refreshLibrary();
      appendLog(`selected model · ${m.name}`);
    });

    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "btn secondary";
    showBtn.textContent = "show";
    showBtn.addEventListener("click", () => window.api.openPath(m.path));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn danger";
    delBtn.textContent = "delete";
    delBtn.addEventListener("click", async () => {
      const ok = window.confirm(`Delete model?\n\n${m.name}`);
      if (!ok) return;
      try {
        await window.api.deleteModel(m.path);
        if (state.selectedModel === m.path) state.selectedModel = null;
        appendLog(`deleted model · ${m.name}`);
        await refreshModels();
        await refreshLibrary();
      } catch (err) {
        $("#library-status").textContent = `delete failed: ${err.message || err}`;
      }
    });

    actions.append(useBtn, showBtn, delBtn);
    row.append(meta, actions);
    list.appendChild(row);
  }

  await refreshModels();
}

async function loadInput(filePath) {
  if (!filePath) return;
  state.inputPath = filePath;
  state.outputPath = null;
  $("#btn-open-out").disabled = true;
  const dataUrl = await window.api.readImagePreview(filePath);
  if (dataUrl) await showBefore(dataUrl);
  $("#image-meta").textContent = `${filePath} · scroll to zoom · drag to pan`;
  $("#btn-upscale").disabled = !state.selectedModel;
  await window.api.setSettings({ lastInputHint: basename(filePath) });
  appendLog(`loaded ${basename(filePath)}`);
}

function formatRuntimeBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

function updateRuntimeLive(payload) {
  const live = $("#runtime-live");
  const stageEl = $("#runtime-live-stage");
  const statsEl = $("#runtime-live-stats");
  if (!live || !stageEl || !statsEl || !payload) return;
  live.hidden = false;
  stageEl.textContent = payload.message || payload.stage || "Working…";
  const expected = payload.expectedBytes || payload.total || Math.round(4.5 * 1024 * 1024 * 1024);
  const bits = [];
  if (payload.packageName) bits.push(payload.packageName);
  if (payload.downloaded != null) {
    const total = payload.total && payload.total > payload.downloaded ? payload.total : expected;
    bits.push(`${formatRuntimeBytes(payload.downloaded)} / ${formatRuntimeBytes(total)}`);
  } else if (payload.diskBytes != null) {
    bits.push(`on disk ${formatRuntimeBytes(payload.diskBytes)}`);
  }
  if (typeof payload.percent === "number") bits.push(`${payload.percent}%`);
  if (payload.elapsedSec != null) bits.push(`${payload.elapsedSec}s`);
  if (payload.stage) bits.push(`stage:${payload.stage}`);
  statsEl.textContent = bits.join(" · ") || "CUDA runtime typically ends around ~4.5 GB";
}

function renderRuntimeSteps(steps = []) {
  const list = $("#runtime-steps");
  if (!list) return;
  list.innerHTML = "";
  for (const step of steps) {
    const li = document.createElement("li");
    li.className = `runtime-step ${step.status || "info"}`;
    const dot = document.createElement("div");
    dot.className = "runtime-step-dot";
    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "runtime-step-title";
    title.textContent = step.title || step.id;
    body.appendChild(title);
    if (step.detail) {
      const detail = document.createElement("div");
      detail.className = "runtime-step-detail";
      detail.textContent = step.detail;
      body.appendChild(detail);
    }
    li.append(dot, body);
    list.appendChild(li);
  }
}

function setRuntimeProgress(pct) {
  const fill = $("#runtime-progress-fill");
  if (fill && typeof pct === "number" && !Number.isNaN(pct)) {
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

function switchTab(tabId) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab || tab.disabled) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  $(`#panel-${tabId}`)?.classList.add("active");
  if (tabId === "models") loadOmdb();
  if (tabId === "library") refreshLibrary();
}

function applyTabLocks(ready) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const id = tab.dataset.tab;
    if (id === "setup") {
      tab.disabled = false;
      tab.classList.remove("locked");
      return;
    }
    const lock = !ready;
    tab.disabled = lock;
    tab.classList.toggle("locked", lock);
  });
  const gate = $("#runtime-gate");
  if (gate) gate.hidden = ready;
}

function renderRuntimeInfo(py) {
  const grid = $("#runtime-info-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const card = (k, v, mono = false) => {
    const el = document.createElement("div");
    el.className = "runtime-info-card";
    el.innerHTML = `<div class="k">${k}</div><div class="v${mono ? " mono" : ""}"></div>`;
    el.querySelector(".v").textContent = v;
    grid.appendChild(el);
  };

  card("Status", py.ready ? "Ready" : "Setup required");
  card("Layout", py.layout || "installed");
  if (py.version) card("Python", py.version);
  if (py.torch) card("PyTorch", String(py.torch));
  card("CUDA", py.cuda ? `Yes${py.gpu ? ` · ${py.gpu}` : ""}` : "No / CPU");
  if (py.spandrel) card("Spandrel", String(py.spandrel));
  if (py.source) card("Source", py.source);
  if (py.disk) {
    card("Venv size", formatRuntimeBytes(py.disk.venvBytes || 0));
    card("App data size", formatRuntimeBytes(py.disk.userDataBytes || 0));
    card("Download cache", formatRuntimeBytes(py.disk.cacheBytes || 0));
    card("Expected CUDA env", `~${formatRuntimeBytes(py.disk.expectedBytes || 4.5 * 1024 ** 3)}`);
  }
  if (py.python && py.python !== "(missing)") card("Interpreter", py.python, true);
  if (py.userData) card("Data folder", py.userData, true);
  if (py.downloadCache) card("Cache folder", py.downloadCache, true);
}

async function refreshRuntimeUi() {
  const py = await window.api.pythonStatus();
  state.runtimeReady = Boolean(py.ready);
  state.runtimeDiagnosis = py.diagnosis || null;

  applyTabLocks(py.ready && !state.runtimeInstalling);

  const badge = $("#runtime-badge");
  if (badge) {
    badge.className = "runtime-badge";
    if (state.runtimeInstalling) {
      badge.classList.add("busy");
      badge.textContent = "Installing";
    } else if (py.ready) {
      badge.classList.add("ok");
      badge.textContent = "Ready";
    } else {
      badge.classList.add("warn");
      badge.textContent = "Setup needed";
    }
  }

  renderRuntimeInfo(py);
  renderRuntimeSteps(py.diagnosis?.steps || []);

  const customPath = $("#runtime-custom-path");
  const customStatus = $("#runtime-custom-status");
  const targetSel = $("#runtime-install-target");
  if (customPath) {
    customPath.textContent = py.customPython || "None selected";
  }
  if (targetSel && py.installTarget) {
    targetSel.value = py.installTarget === "selected" ? "selected" : "appdata";
  }
  if (customStatus) {
    const cand = py.customCandidate || py.diagnosis?.customCandidate;
    if (!py.customPython) {
      customStatus.textContent = "Optional — e.g. ComfyUI\\venv from Stability Matrix.";
    } else if (cand?.ready || (py.ready && py.source === "custom")) {
      customStatus.textContent = `Ready · torch ${cand?.torch || py.torch || "?"}${
        cand?.cuda || py.cuda ? " · CUDA" : ""
      }`;
    } else if (cand?.version) {
      customStatus.textContent = `Found Python ${cand.version} · missing: ${(cand.missing || py.missing || []).join(", ") || "deps"}`;
    } else {
      customStatus.textContent = "Path saved but not usable yet — Rescan or pick another folder.";
    }
  }

  const active = $("#runtime-active");
  const pathEl = $("#runtime-active-path");
  const metaEl = $("#runtime-active-meta");
  if (active && pathEl && metaEl) {
    if (py.ready && py.python && py.python !== "(missing)") {
      active.hidden = false;
      pathEl.textContent = py.python;
      metaEl.textContent = [py.source && `source: ${py.source}`, py.note].filter(Boolean).join(" · ");
    } else {
      active.hidden = true;
    }
  }

  const installBtn = $("#btn-install-runtime");
  const cancelBtn = $("#btn-cancel-runtime");
  if (installBtn) {
    installBtn.disabled = Boolean(state.runtimeInstalling);
    const cand = py.customCandidate || py.diagnosis?.customCandidate;
    if (py.ready) {
      installBtn.textContent = "Re-check / repair runtime";
    } else if (cand?.version && (py.installTarget || "appdata") === "selected") {
      installBtn.textContent = `Install missing into selected env`;
    } else if (cand?.version) {
      installBtn.textContent = "Create AppData venv + install (~4.5 GB if torch needed)";
    } else if (py.diagnosis?.baseForInstall) {
      installBtn.textContent = "Create AppData venv + install (~4.5 GB)";
    } else {
      installBtn.textContent = "Download Python + install (~4.5 GB)";
    }
  }
  if (cancelBtn) {
    cancelBtn.hidden = !state.runtimeInstalling;
    cancelBtn.disabled = !state.runtimeInstalling;
  }

  return py;
}

async function installRuntime() {
  if (state.runtimeInstalling) return;
  state.runtimeInstalling = true;
  switchTab("setup");
  applyTabLocks(false);
  await refreshRuntimeUi();
  setProgress(2, "setting up AI runtime…");
  setRuntimeProgress(2);
  appendLog("runtime setup started…");
  const live = $("#runtime-live");
  if (live) live.hidden = false;
  try {
    const result = await window.api.installRuntime();
    if (result?.cancelled) {
      appendLog("runtime setup cancelled — incomplete venv + download cache cleared");
      setProgress(0, "runtime setup cancelled");
      setRuntimeProgress(0);
      if (live) {
        $("#runtime-live-stage").textContent = "Cancelled";
        $("#runtime-live-stats").textContent = "Cache and incomplete venv were removed";
      }
      await refreshRuntimeUi();
      return;
    }
    const msg = result.already
      ? `reused existing runtime · ${result.python}`
      : `runtime ready · ${result.python}`;
    appendLog(msg);
    if (result.cacheCleared) appendLog("download cache cleared after successful setup");
    setProgress(100, "AI runtime ready");
    setRuntimeProgress(100);
    if (live) {
      $("#runtime-live-stage").textContent = "AI runtime ready";
      $("#runtime-live-stats").textContent = result.python || "";
    }
    await refreshRuntimeUi();
  } catch (err) {
    if (String(err?.message || err).toLowerCase().includes("cancel")) {
      appendLog("runtime setup cancelled");
      setProgress(0, "runtime setup cancelled");
      setRuntimeProgress(0);
    } else {
      appendLog(`runtime setup failed · ${err.message || err}`);
      setProgress(0, "runtime setup failed");
      setRuntimeProgress(0);
    }
    throw err;
  } finally {
    state.runtimeInstalling = false;
    await refreshRuntimeUi();
  }
}

async function cancelRuntimeInstall() {
  if (!state.runtimeInstalling) return;
  appendLog("cancel requested — stopping downloads and clearing cache…");
  const cancelBtn = $("#btn-cancel-runtime");
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    await window.api.cancelRuntimeInstall();
  } catch (err) {
    appendLog(`cancel failed · ${err.message || err}`);
  }
}

async function runUpscale() {
  if (!state.inputPath || !state.selectedModel || state.busy) return;

  const py = await refreshRuntimeUi();
  if (!py.ready) {
    appendLog("AI runtime missing — open the Setup tab to finish setup.");
    switchTab("setup");
    setProgress(0, "runtime setup required");
    return;
  }

  const defaultName = `${stem(state.inputPath)}_x${
    state.mode === "factor" ? state.factor : state.longest
  }.${state.format}`;
  const output = await window.api.pickSave({ defaultName, format: state.format });
  if (!output) return;

  state.busy = true;
  $("#btn-upscale").disabled = true;
  $("#btn-cancel").disabled = false;
  setProgress(1, "starting…");
  appendLog(`upscaling with ${basename(state.selectedModel)}`);

  await window.api.setSettings({
    lastModel: state.selectedModel,
    lastFormat: state.format,
    mode: state.mode,
    factor: state.factor,
    longest: state.longest,
    tile: state.tile,
  });

  try {
    const result = await window.api.upscale({
      input: state.inputPath,
      output,
      modelPath: state.selectedModel,
      mode: state.mode,
      factor: state.factor,
      longest: state.longest,
      format: state.format,
      tile: state.tile,
    });
    state.outputPath = result.output || output;
    const preview = await window.api.readImagePreview(state.outputPath);
    if (preview) await showAfter(preview);
    $("#btn-open-out").disabled = false;
    setProgress(100, `done · ${result.width || "?"}×${result.height || "?"}`);
    appendLog(`saved ${state.outputPath}`);
  } catch (err) {
    setProgress(0, "failed");
    appendLog(`ERROR: ${err.message || err}`);
  } finally {
    state.busy = false;
    $("#btn-upscale").disabled = !state.inputPath || !state.selectedModel;
    $("#btn-cancel").disabled = true;
  }
}

function truncate(text, max = 140) {
  const t = String(text || "")
    .replace(/\\n/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "No description.";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function missingPreviewEl() {
  const ph = document.createElement("div");
  ph.className = "placeholder-preview";
  ph.textContent = "missing preview";
  return ph;
}

/** Hosts that usually still serve real comparison images. */
const RELIABLE_PREVIEW_HOSTS = [
  "openmodeldb.info",
  "slow.pics",
  "i.slow.pics",
  "imgsli.com",
  "i.imgsli.com",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
];

/** Hosts that often return a fake "unavailable" JPEG (onload succeeds). */
const DEAD_PREVIEW_HOSTS = [
  "imgbox.com",
  "images2.imgbox.com",
  "thumbs2.imgbox.com",
  "freeimage.host",
  "iili.io",
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isReliablePreviewUrl(url) {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  if (DEAD_PREVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return RELIABLE_PREVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function isOmdbThumb(url) {
  const host = hostOf(url);
  return host === "openmodeldb.info" && /\/thumbs\//i.test(url || "");
}

function wireImageFallback(img, onFail) {
  img.addEventListener("error", () => onFail(), { once: true });
  img.addEventListener(
    "load",
    () => {
      // Dead hosts sometimes return a tiny placeholder JPEG with 200 OK.
      if (!img.naturalWidth || !img.naturalHeight) {
        onFail();
        return;
      }
      if (!isReliablePreviewUrl(img.currentSrc || img.src)) {
        onFail();
      }
    },
    { once: true }
  );
}

function mountSolo(preview, url, onFail) {
  const img = document.createElement("img");
  img.className = "solo";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  wireImageFallback(img, onFail);
  img.src = url;
  preview.insertBefore(img, preview.firstChild);
}

function buildPreview(m) {
  const preview = document.createElement("div");
  preview.className = "preview";

  const showMissing = () => {
    preview.querySelectorAll("img, .pair, .solo, .placeholder-preview").forEach((n) => n.remove());
    preview.insertBefore(missingPreviewEl(), preview.firstChild);
  };

  const showThumbOrMissing = () => {
    preview.querySelectorAll("img, .pair, .solo").forEach((n) => n.remove());
    const thumb = [m.thumbnail, m.preview].find((u) => u && (isOmdbThumb(u) || isReliablePreviewUrl(u)));
    if (thumb) mountSolo(preview, thumb, showMissing);
    else showMissing();
  };

  const mountPair = (lrUrl, srUrl) => {
    const pair = document.createElement("div");
    pair.className = "pair";
    const lr = document.createElement("img");
    const sr = document.createElement("img");
    lr.loading = "lazy";
    sr.loading = "lazy";
    lr.decoding = "async";
    sr.decoding = "async";
    lr.referrerPolicy = "no-referrer";
    sr.referrerPolicy = "no-referrer";
    lr.alt = "before";
    sr.alt = "after";
    let settled = false;
    const failPair = () => {
      if (settled) return;
      settled = true;
      pair.remove();
      showThumbOrMissing();
    };
    wireImageFallback(lr, failPair);
    wireImageFallback(sr, failPair);
    lr.src = lrUrl;
    sr.src = srUrl;
    pair.append(lr, sr);
    preview.insertBefore(pair, preview.firstChild);
  };

  const canPair =
    m.lr &&
    m.sr &&
    isReliablePreviewUrl(m.lr) &&
    isReliablePreviewUrl(m.sr);

  if (canPair) {
    mountPair(m.lr, m.sr);
  } else {
    showThumbOrMissing();
  }

  const badges = document.createElement("div");
  badges.className = "preview-badges";
  if (m.architecture) {
    const a = document.createElement("span");
    a.className = "badge";
    a.textContent = m.architecture;
    badges.appendChild(a);
  }
  if (m.scale) {
    const s = document.createElement("span");
    s.className = "badge scale";
    s.textContent = `${m.scale}x`;
    badges.appendChild(s);
  }
  preview.appendChild(badges);
  return preview;
}

function renderOmdbCards(models) {
  const grid = $("#omdb-grid");
  grid.innerHTML = "";
  for (const m of models) {
    const card = document.createElement("article");
    card.className = "model-card";
    card.appendChild(buildPreview(m));

    const body = document.createElement("div");
    body.className = "body";

    const title = document.createElement("h3");
    title.textContent = m.name;
    body.appendChild(title);

    const by = document.createElement("p");
    by.className = "by";
    by.textContent = m.author ? `by ${m.author}` : "";
    body.appendChild(by);

    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = truncate(m.description, 160);
    body.appendChild(desc);

    if (m.githubUrl) {
      const gh = document.createElement("button");
      gh.type = "button";
      gh.className = "card-link";
      gh.textContent = "GitHub release";
      gh.title = m.githubUrl;
      gh.addEventListener("click", (e) => {
        e.stopPropagation();
        window.api.openExternal(m.githubUrl);
      });
      body.appendChild(gh);
    }

    if (m.tags?.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const t of m.tags.slice(0, 4)) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = t;
        tags.appendChild(tag);
      }
      body.appendChild(tags);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "btn primary";
    dl.textContent = "Download";
    dl.disabled = !m.downloadUrl;
    dl.addEventListener("click", async (e) => {
      e.stopPropagation();
      const prevLabel = dl.textContent;
      dl.disabled = true;
      dl.textContent = "Downloading…";
      try {
        $("#omdb-status").textContent = `downloading ${m.name}…`;
        const filename = `${m.id}.${m.resourceType === "safetensors" ? "safetensors" : "pth"}`;
        const saved = await window.api.downloadModel({
          id: m.id,
          url: m.downloadUrl,
          urls: m.downloadUrls || [m.downloadUrl],
          filename,
          expectedSize: m.size,
          size: m.size,
          sha256: m.sha256,
        });
        $("#omdb-status").textContent = `saved ${saved.name} (${Math.round(saved.size / 1048576)} MB) — offline ready`;
        appendLog(`downloaded model → ${saved.path} (${saved.size} bytes)`);
        dl.textContent = "Downloaded";
        await refreshModels();
        state.selectedModel = saved.path;
        $("#model-select").value = saved.path;
        if ($("#panel-library")?.classList.contains("active")) await refreshLibrary();
      } catch (err) {
        $("#omdb-status").textContent = `download failed: ${err.message || err}`;
        appendLog(`download failed · ${m.name} · ${err.message || err}`);
        dl.textContent = prevLabel;
        dl.disabled = !m.downloadUrl;
      }
    });

    const page = document.createElement("button");
    page.type = "button";
    page.className = "btn secondary";
    page.textContent = "Webpage";
    page.addEventListener("click", (e) => {
      e.stopPropagation();
      window.api.openExternal(
        m.pageUrl || `https://openmodeldb.info/models/${encodeURIComponent(m.id)}`
      );
    });

    actions.append(dl, page);
    body.appendChild(actions);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

let omdbTimer = null;
const OMDB_PAGE_SIZE = 36;
let omdbPage = 0;
let omdbTotal = 0;

function updateOmdbPager() {
  const pager = $("#omdb-pager");
  const label = $("#omdb-page-label");
  const prev = $("#btn-omdb-prev");
  const next = $("#btn-omdb-next");
  if (!pager || !label || !prev || !next) return;
  const pages = Math.max(1, Math.ceil(omdbTotal / OMDB_PAGE_SIZE) || 1);
  const page = Math.min(omdbPage, pages - 1);
  omdbPage = Math.max(0, page);
  pager.hidden = omdbTotal <= OMDB_PAGE_SIZE;
  label.textContent = `Page ${omdbPage + 1} / ${pages}`;
  prev.disabled = omdbPage <= 0;
  next.disabled = omdbPage >= pages - 1;
}

async function loadOmdb({ resetPage = false } = {}) {
  if (resetPage) omdbPage = 0;
  $("#omdb-status").textContent = "fetching openmodeldb catalog…";
  try {
    const query = $("#omdb-query").value.trim();
    const scale = $("#omdb-scale").value || null;
    const result = await window.api.omdbList({
      query,
      scale,
      limit: OMDB_PAGE_SIZE,
      offset: omdbPage * OMDB_PAGE_SIZE,
    });
    omdbTotal = result.total || 0;
    const pages = Math.max(1, Math.ceil(omdbTotal / OMDB_PAGE_SIZE) || 1);
    if (omdbPage >= pages) {
      omdbPage = Math.max(0, pages - 1);
      return loadOmdb();
    }
    renderOmdbCards(result.models);
    updateOmdbPager();
    const from = omdbTotal ? omdbPage * OMDB_PAGE_SIZE + 1 : 0;
    const to = omdbPage * OMDB_PAGE_SIZE + (result.models?.length || 0);
    $("#omdb-status").textContent = omdbTotal
      ? `showing ${from}–${to} of ${omdbTotal} matches · ranked by preview quality, then name`
      : "no matches";
  } catch (err) {
    $("#omdb-status").textContent = `failed to load catalog: ${err.message || err}`;
    const pager = $("#omdb-pager");
    if (pager) pager.hidden = true;
  }
}

function wireCompareInteractions() {
  const viewport = $("#compare-viewport");
  const handle = document.querySelector(".slider-handle");
  let draggingSlider = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  const setSplitFromClientX = (clientX) => {
    if (!state.hasResult) return;
    const world = $("#compare-world");
    const rect = world.getBoundingClientRect();
    if (!rect.width) return;
    state.split = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    applySplit();
  };

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    draggingSlider = true;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!draggingSlider) return;
    setSplitFromClientX(e.clientX);
  });
  handle.addEventListener("pointerup", () => {
    draggingSlider = false;
  });

  viewport.addEventListener("pointerdown", (e) => {
    if (!state.beforeUrl) return;
    if (draggingSlider || e.target.closest(".slider-handle")) return;
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.classList.add("grabbing");
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!panning) return;
    state.panX += e.clientX - lastX;
    state.panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  viewport.addEventListener("pointerup", () => {
    panning = false;
    viewport.classList.remove("grabbing");
  });

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!state.beforeUrl) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      state.zoom = Math.max(0.2, Math.min(8, state.zoom * delta));
      applyTransform();
    },
    { passive: false }
  );
}

function wireUi() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.disabled || tab.classList.contains("locked")) return;
      switchTab(tab.dataset.tab);
    });
  });

  document.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      syncModeUi();
    });
  });

  document.querySelectorAll("#factor-chips .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.factor = Number(btn.dataset.factor);
      syncChipUi();
    });
  });

  document.querySelectorAll("#longest-chips .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.longest = Number(btn.dataset.longest);
      syncChipUi();
    });
  });

  const applyCustomLongest = () => {
    const input = $("#longest-custom");
    if (!input) return;
    state.longest = clampLongest(input.value);
    syncChipUi();
  };
  $("#longest-custom")?.addEventListener("change", applyCustomLongest);
  $("#longest-custom")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCustomLongest();
    }
  });

  $("#format-select").addEventListener("change", (e) => {
    state.format = e.target.value;
  });
  $("#tile-select").addEventListener("change", (e) => {
    state.tile = Number(e.target.value);
  });
  $("#model-select").addEventListener("change", (e) => {
    state.selectedModel = e.target.value || null;
    $("#btn-upscale").disabled = !state.inputPath || !state.selectedModel;
  });

  const viewer = $("#viewer");
  const browse = async (e) => {
    e?.stopPropagation?.();
    const file = await window.api.pickImage();
    if (file) await loadInput(file);
  };
  $("#btn-browse").addEventListener("click", browse);
  $("#btn-change-image").addEventListener("click", async (e) => {
    e.stopPropagation();
    await browse(e);
  });
  viewer.addEventListener("click", async (e) => {
    if (state.beforeUrl) return;
    if (e.target.closest("button")) return;
    await browse(e);
  });

  viewer.addEventListener("dragover", (e) => {
    e.preventDefault();
    viewer.classList.add("drag");
  });
  viewer.addEventListener("dragleave", () => viewer.classList.remove("drag"));
  viewer.addEventListener("drop", async (e) => {
    e.preventDefault();
    viewer.classList.remove("drag");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const filePath = window.api.pathForFile(file);
    if (filePath) await loadInput(filePath);
  });

  window.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const path = await window.api.pasteImage();
          if (path) await loadInput(path);
          return;
        }
      }
    }
    const path = await window.api.pasteImage();
    if (path) await loadInput(path);
  });

  $("#btn-upscale").addEventListener("click", runUpscale);
  $("#btn-install-runtime")?.addEventListener("click", () => {
    installRuntime().catch(() => {});
  });
  $("#btn-cancel-runtime")?.addEventListener("click", () => {
    cancelRuntimeInstall().catch(() => {});
  });
  $("#btn-pick-python-env")?.addEventListener("click", async () => {
    try {
      const picked = await window.api.pickPythonEnv();
      if (!picked) return;
      appendLog(`selected env · ${picked.python}`);
      if (picked.ready) appendLog("selected env is ready (torch + spandrel)");
      else appendLog(`selected env missing · ${(picked.missing || []).join(", ") || "deps"}`);
      await refreshRuntimeUi();
    } catch (err) {
      appendLog(`select env failed · ${err.message || err}`);
    }
  });
  $("#btn-clear-python-env")?.addEventListener("click", async () => {
    await window.api.clearCustomPython();
    appendLog("cleared selected environment");
    await refreshRuntimeUi();
  });
  $("#runtime-install-target")?.addEventListener("change", async (e) => {
    const value = e.target.value === "selected" ? "selected" : "appdata";
    await window.api.setInstallTarget(value);
    appendLog(`install target · ${value}`);
    await refreshRuntimeUi();
  });
  $("#btn-rescan-runtime")?.addEventListener("click", async () => {
    appendLog("runtime rescan…");
    const py = await refreshRuntimeUi();
    appendLog(`runtime rescan · ${py.ready ? "ready" : "setup needed"} · ${py.python}`);
    if (!py.ready) switchTab("setup");
  });
  $("#btn-open-runtime-folder")?.addEventListener("click", async () => {
    await window.api.openRuntimeFolder();
  });
  $("#btn-open-cache-folder")?.addEventListener("click", async () => {
    await window.api.openDownloadCache();
  });
  $("#btn-cancel").addEventListener("click", async () => {
    await window.api.cancelUpscale();
    appendLog("cancel requested");
  });
  $("#btn-open-out").addEventListener("click", () => {
    if (state.outputPath) window.api.openPath(state.outputPath);
  });
  $("#btn-clear-log").addEventListener("click", () => {
    clearLogs();
  });
  $("#btn-clear-runtime-log")?.addEventListener("click", () => {
    clearLogs();
  });
  $("#btn-toggle-console").addEventListener("click", () => {
    const panel = $("#console");
    const btn = $("#btn-toggle-console");
    const open = panel.classList.toggle("collapsed");
    // classList.toggle returns true if class is now present
    btn.textContent = open ? "Show console" : "Hide console";
  });

  $("#btn-omdb-refresh").addEventListener("click", async () => {
    await window.api.omdbRefresh();
    await loadOmdb({ resetPage: true });
  });
  $("#btn-omdb-prev")?.addEventListener("click", () => {
    if (omdbPage <= 0) return;
    omdbPage -= 1;
    loadOmdb();
  });
  $("#btn-omdb-next")?.addEventListener("click", () => {
    const pages = Math.max(1, Math.ceil(omdbTotal / OMDB_PAGE_SIZE) || 1);
    if (omdbPage >= pages - 1) return;
    omdbPage += 1;
    loadOmdb();
  });
  $("#btn-import-model").addEventListener("click", async () => {
    try {
      const imported = await window.api.importModel();
      if (!imported) return;
      state.selectedModel = imported.path;
      await window.api.setSettings({ lastModel: imported.path });
      appendLog(`imported model · ${imported.name}`);
      await refreshModels();
      await refreshLibrary();
    } catch (err) {
      $("#library-status").textContent = `import failed: ${err.message || err}`;
    }
  });
  $("#btn-open-models-folder").addEventListener("click", async () => {
    await window.api.openModelsFolder();
  });
  $("#btn-refresh-library").addEventListener("click", () => refreshLibrary());
  $("#omdb-site").addEventListener("click", (e) => {
    e.preventDefault();
    window.api.openExternal("https://openmodeldb.info/");
  });
  $("#omdb-query").addEventListener("input", () => {
    clearTimeout(omdbTimer);
    omdbTimer = setTimeout(() => loadOmdb({ resetPage: true }), 280);
  });
  $("#omdb-scale").addEventListener("change", () => loadOmdb({ resetPage: true }));

  wireCompareInteractions();

  window.api.onUpscaleProgress((payload) => {
    if (payload.type === "progress") {
      setProgress(payload.percent, payload.stage || "working…");
    }
  });
  window.api.onUpscaleLog((line) => appendLog(line));
  window.api.onDownloadProgress((p) => {
    if (!p) return;
    if (p.total && p.total > 1024 * 1024) {
      const mb = (p.received / 1048576).toFixed(1);
      const totalMb = (p.total / 1048576).toFixed(1);
      $("#omdb-status").textContent = `downloading… ${p.percent || 0}% (${mb}/${totalMb} MB)`;
    } else if (p.received > 1024 * 1024) {
      const mb = (p.received / 1048576).toFixed(1);
      $("#omdb-status").textContent = `downloading… ${mb} MB`;
    } else {
      $("#omdb-status").textContent = `downloading… contacting host`;
    }
  });
}

async function boot() {
  wireUi();
  syncModeUi();
  syncChipUi();
  updateViewerChrome();

  const settings = await window.api.getSettings();
  state.mode = settings.mode || "factor";
  state.factor = settings.factor || 4;
  state.longest = clampLongest(settings.longest || 2048);
  state.format = settings.lastFormat || "png";
  state.tile = settings.tile || 256;
  $("#format-select").value = state.format;
  $("#tile-select").value = String(state.tile);
  if ($("#longest-custom")) $("#longest-custom").value = String(state.longest);
  syncModeUi();
  syncChipUi();

  await refreshModels();
  if (settings.lastModel && state.models.some((m) => m.path === settings.lastModel)) {
    state.selectedModel = settings.lastModel;
    $("#model-select").value = settings.lastModel;
  }

  window.api.onRuntimeProgress((payload) => {
    if (!payload) return;
    updateRuntimeLive(payload);
    if (typeof payload.percent === "number") {
      setProgress(payload.percent, payload.message || payload.stage || "installing…");
      setRuntimeProgress(payload.percent, payload.message || payload.stage || "installing…");
    } else if (payload.diskBytes != null && payload.expectedBytes) {
      const pct = Math.min(95, Math.round((payload.diskBytes / payload.expectedBytes) * 100));
      setProgress(pct, payload.message || "installing…");
      setRuntimeProgress(pct, payload.message || "installing…");
    } else if (payload.message) {
      setProgress(undefined, payload.message);
      setRuntimeProgress(undefined, payload.message);
    }
  });
  window.api.onRuntimeLog((line) => appendLog(line));

  const py = await refreshRuntimeUi();
  if (!py.ready) {
    switchTab("setup");
    appendLog("AI runtime setup required — other tabs are locked until this finishes.");
  }
  appendLog(`python · ${py.python}${py.ready ? "" : " · NOT READY"}`);
  if (py.source) appendLog(`runtime source · ${py.source}`);
  appendLog(`layout · ${py.layout || "installed"} · userData · ${py.userData}`);
  if (py.portableDir) appendLog(`portable dir · ${py.portableDir}`);
  appendLog(`models · ${py.modelsDir}`);
  if (!state.models.length) {
    appendLog("place .pth / .safetensors in models/ or download from openmodeldb");
  }
}

boot();

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");

const UV_VERSION = "0.6.14";
const UV_ZIP =
  process.platform === "win32"
    ? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
    : null;

/** Rough final size of AppData python/.venv + cache with CUDA PyTorch. */
const EXPECTED_RUNTIME_BYTES = Math.round(4.5 * 1024 * 1024 * 1024);
const EXPECTED_RUNTIME_LABEL = "~4.5 GB";

class RuntimeCancelledError extends Error {
  constructor(message = "Runtime install cancelled") {
    super(message);
    this.name = "RuntimeCancelledError";
    this.cancelled = true;
  }
}

/** @type {{ aborted: boolean, children: Set<import('child_process').ChildProcess>, requests: Set<import('http').ClientRequest>, userDataDir: string|null, downloadCacheDir: string|null } | null} */
let installSession = null;

function beginInstallSession(paths = {}) {
  installSession = {
    aborted: false,
    children: new Set(),
    requests: new Set(),
    userDataDir: paths.userDataDir || null,
    downloadCacheDir: paths.downloadCacheDir || null,
  };
  return installSession;
}

function endInstallSession() {
  installSession = null;
}

function throwIfAborted() {
  if (installSession?.aborted) throw new RuntimeCancelledError();
}

function cancelRuntimeInstall() {
  if (!installSession) return { ok: false, reason: "idle" };
  installSession.aborted = true;
  for (const child of installSession.children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  for (const req of installSession.requests) {
    try {
      req.destroy(new RuntimeCancelledError());
    } catch {
      /* ignore */
    }
  }
  return {
    ok: true,
    userDataDir: installSession.userDataDir,
    downloadCacheDir: installSession.downloadCacheDir,
  };
}

function rmDirSafe(dir, onLog) {
  if (!dir || !exists(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    onLog?.(`Removed ${dir}`);
    return true;
  } catch (err) {
    onLog?.(`Could not remove ${dir}: ${err.message || err}`);
    return false;
  }
}

function clearInstallArtifacts({ userDataDir, downloadCacheDir, onLog } = {}) {
  const venv = userDataDir ? path.join(userDataDir, "python", ".venv") : null;
  rmDirSafe(venv, onLog);
  rmDirSafe(downloadCacheDir, onLog);
  return { venvCleared: Boolean(venv), cacheCleared: Boolean(downloadCacheDir) };
}

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: opts.timeout || 60000,
    env: opts.env || process.env,
  });
}

function looksLikeStoreStub(text) {
  return /Microsoft Store|python\.org\/about|Washer|introuvable/i.test(String(text || ""));
}

/**
 * Probe a Python executable. Returns null if unusable (missing, store stub, <3.10).
 */
function inspectPython(cmdOrPath) {
  if (!cmdOrPath) return null;
  const isPath = /[\\/]/.test(cmdOrPath) || /\.exe$/i.test(cmdOrPath);
  if (isPath && !exists(cmdOrPath)) return null;

  const script = [
    "import sys, json",
    "info = {",
    "  'executable': sys.executable,",
    "  'version': '.'.join(map(str, sys.version_info[:3])),",
    "  'major': sys.version_info[0],",
    "  'minor': sys.version_info[1],",
    "  'prefix': sys.prefix,",
    "}",
    "try:",
    "  import torch",
    "  info['torch'] = getattr(torch, '__version__', 'yes')",
    "  info['cuda'] = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())",
    "  if info['cuda']:",
    "    try: info['gpu'] = torch.cuda.get_device_name(0)",
    "    except Exception: info['gpu'] = True",
    "except Exception:",
    "  info['torch'] = None",
    "  info['cuda'] = False",
    "  info['gpu'] = None",
    "try:",
    "  import spandrel",
    "  info['spandrel'] = getattr(spandrel, '__version__', 'yes')",
    "except Exception:",
    "  info['spandrel'] = None",
    "try:",
    "  import PIL",
    "  info['pil'] = True",
    "except Exception:",
    "  info['pil'] = False",
    "print(json.dumps(info))",
  ].join("\n");

  const probe = runCapture(cmdOrPath, ["-c", script], { timeout: 90000 });
  const combined = `${probe.stdout || ""}${probe.stderr || ""}`;
  if (probe.status !== 0 || looksLikeStoreStub(combined)) return null;

  try {
    const line = String(probe.stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    const info = JSON.parse(line);
    if (info.major < 3 || (info.major === 3 && info.minor < 10)) return null;
    info.cmd = cmdOrPath;
    info.missing = [];
    if (!info.torch) info.missing.push("torch", "torchvision");
    if (!info.spandrel) info.missing.push("spandrel", "spandrel_extra_arches");
    if (!info.pil) info.missing.push("Pillow");
    // de-dupe while preserving order
    info.missing = [...new Set(info.missing)];
    info.ready = Boolean(info.torch && info.spandrel && info.pil);
    info.sourceHint = classifySource(info.executable || cmdOrPath);
    return info;
  } catch {
    return null;
  }
}

function classifySource(executable) {
  const p = String(executable || "").toLowerCase();
  if (p.includes(`${path.sep}appdata${path.sep}`) || p.includes("/appdata/")) return "app-managed";
  if (p.includes(".venv")) return "venv";
  if (p.includes("conda") || p.includes("miniconda") || p.includes("anaconda")) return "conda";
  if (p.includes("python3") || p.includes("python")) return "system";
  return "custom";
}

function venvPythonPath(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Accept a venv folder or python.exe path and return the interpreter path.
 */
function resolveEnvPython(inputPath) {
  if (!inputPath) return null;
  const p = path.resolve(String(inputPath));
  if (!exists(p)) return null;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) {
      const base = path.basename(p).toLowerCase();
      if (base === "python.exe" || base === "python" || base === "python3") return p;
      return null;
    }
    if (st.isDirectory()) {
      const candidates = [
        venvPythonPath(p),
        path.join(p, "python.exe"),
        path.join(p, "bin", "python"),
        path.join(p, "Scripts", "python.exe"),
      ];
      for (const c of candidates) {
        if (exists(c)) return c;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function clearDownloadCache(downloadCacheDir, onLog) {
  if (!downloadCacheDir || !exists(downloadCacheDir)) return false;
  onLog?.(`Clearing download cache (setup complete): ${downloadCacheDir}`);
  return rmDirSafe(downloadCacheDir, onLog);
}

function findSystemPythonCommands() {
  const found = [];
  const pushUnique = (label, cmd) => {
    if (!cmd) return;
    if (found.some((f) => f.cmd === cmd)) return;
    found.push({ label, cmd });
  };

  for (const envKey of ["UPSCALER_PYTHON", "PYTHON"]) {
    if (process.env[envKey]) pushUnique(`env:${envKey}`, process.env[envKey]);
  }

  if (process.platform === "win32") {
    const r = runCapture("py", ["-3", "-c", "import sys; print(sys.executable)"]);
    if (r.status === 0) {
      const exe = String(r.stdout || "").trim().split(/\r?\n/)[0];
      pushUnique("py -3", exe);
    }
    // Also try common installs
    const localApp = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    for (const ver of ["312", "311", "310", "313"]) {
      pushUnique(
        `Python3${ver.slice(1)}`,
        path.join(localApp, "Programs", "Python", `Python${ver}`, "python.exe")
      );
      pushUnique(
        `Python3${ver.slice(1)} (x64)`,
        path.join(programFiles, "Python" + ver, "python.exe")
      );
    }
  }

  for (const cmd of process.platform === "win32" ? ["python3", "python"] : ["python3", "python"]) {
    pushUnique(cmd, cmd);
  }

  return found;
}

/**
 * Discover every candidate and build a diagnostic report.
 * Preference order for *use*:
 *  1. UPSCALER_PYTHON if ready
 *  2. App userData venv if ready
 *  3. Dev project venv if ready
 *  4. Any system/conda Python that already has torch+spandrel
 *  5. Otherwise not ready (install will create app venv, prefer system Python as base)
 */
function diagnoseEnvironment(paths) {
  const steps = [];
  const add = (id, status, title, detail, extra = {}) => {
    steps.push({ id, status, title, detail, ...extra });
  };

  const userVenvPy = venvPythonPath(path.join(paths.userDataDir, "python", ".venv"));
  const localVenvPy = venvPythonPath(path.join(paths.projectPythonDir, ".venv"));
  const customPy = resolveEnvPython(paths.customPython) || (paths.customPython || null);

  add(
    "paths",
    "info",
    "App paths",
    [
      paths.layout ? `mode: ${paths.layout}` : null,
      paths.portableDir ? `portable exe dir: ${paths.portableDir}` : null,
      `userData (venv): ${paths.userDataDir}`,
      paths.downloadCacheDir ? `download cache: ${paths.downloadCacheDir}` : null,
      customPy ? `custom env: ${customPy}` : null,
      `resources: ${paths.resourcesDir || "(dev)"}`,
      `requirements: ${paths.requirementsFile}`,
    ]
      .filter(Boolean)
      .join("\n")
  );

  const candidates = [];
  const consider = (label, cmd, kind) => {
    if (!cmd) return;
    if (candidates.some((c) => c.cmd === cmd || c.executable === cmd)) return;
    const info = inspectPython(cmd);
    if (!info) {
      if (exists(cmd) || !/[\\/]/.test(cmd)) {
        candidates.push({
          label,
          kind,
          cmd,
          executable: cmd,
          ready: false,
          missing: ["torch", "torchvision", "spandrel", "spandrel_extra_arches", "Pillow"],
          note: exists(cmd) ? "exists but not usable (version/store stub)" : "not found / not runnable",
        });
      }
      return;
    }
    candidates.push({
      label,
      kind,
      cmd,
      ...info,
      note: info.ready
        ? `ready · torch ${info.torch}${info.cuda ? " · CUDA" : " · CPU"}${info.gpu ? ` · ${info.gpu}` : ""}`
        : `Python ${info.version} · missing: ${(info.missing || []).join(", ") || "deps"}`,
    });
  };

  consider("Selected environment", customPy, "custom");
  consider("UPSCALER_PYTHON", process.env.UPSCALER_PYTHON, "env");
  consider("App-managed venv", userVenvPy, "app-venv");
  consider("Project venv", localVenvPy, "project-venv");

  for (const s of findSystemPythonCommands()) {
    consider(s.label, s.cmd, "system");
  }

  const ready = candidates.filter((c) => c.ready);
  const preferred =
    ready.find((c) => c.kind === "custom") ||
    ready.find((c) => c.kind === "env") ||
    ready.find((c) => c.kind === "app-venv") ||
    ready.find((c) => c.kind === "project-venv") ||
    ready.find((c) => c.kind === "system") ||
    null;

  const customCandidate = candidates.find((c) => c.kind === "custom") || null;

  // Base Python for creating a new venv (prefer custom / system install over downloading)
  const baseForInstall =
    candidates.find((c) => c.kind === "custom" && c.version) ||
    candidates.find((c) => c.kind === "env" && c.version) ||
    candidates.find((c) => c.kind === "system" && c.version) ||
    candidates.find((c) => c.version) ||
    null;

  for (const c of candidates) {
    // Hide bare PATH stubs (python / python3 "not found") when a real env is already chosen.
    if (
      c.kind === "system" &&
      !c.version &&
      (c.label === "python" || c.label === "python3") &&
      (preferred || customCandidate?.version)
    ) {
      continue;
    }
    add(
      `cand-${c.kind}-${c.label}`,
      c.ready ? "ok" : c.version ? "warn" : "skip",
      c.label,
      `${c.executable || c.cmd}\n${c.note || ""}`
    );
  }

  if (preferred) {
    add(
      "decision",
      "ok",
      "Using existing runtime",
      `${preferred.executable}\n${preferred.note}\n(source: ${preferred.kind})`
    );
  } else if (customCandidate?.version) {
    add(
      "decision",
      "warn",
      "Selected env needs packages",
      `${customCandidate.executable}\nMissing: ${(customCandidate.missing || []).join(", ")}\nChoose install target below (AppData isolated, or into this env).`
    );
  } else if (baseForInstall) {
    add(
      "decision",
      "warn",
      "Will create app venv from your Python",
      `${baseForInstall.executable}\nPython ${baseForInstall.version} found, but torch/spandrel incomplete — install into AppData venv.`
    );
  } else {
    add(
      "decision",
      "warn",
      "No usable Python found",
      "Will download uv + Python 3.11 into AppData, then install torch/spandrel (one-time)."
    );
  }

  return {
    ready: Boolean(preferred),
    python: preferred ? preferred.executable : null,
    preferred,
    customCandidate,
    baseForInstall,
    candidates,
    steps,
    paths: {
      userData: paths.userDataDir,
      downloadCache: paths.downloadCacheDir || null,
      userVenv: userVenvPy,
      projectVenv: localVenvPy,
      customPython: customPy,
      requirements: paths.requirementsFile,
      resources: paths.resourcesDir,
    },
  };
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    throwIfAborted();
    const follow = (current, redirects = 0) => {
      if (redirects > 8) return reject(new Error("Too many redirects"));
      throwIfAborted();
      const lib = current.startsWith("https") ? https : http;
      const req = lib.get(
        current,
        {
          headers: { "User-Agent": "OpenModelDB-Upscaler" },
          timeout: 600000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            installSession?.requests.delete(req);
            return follow(new URL(res.headers.location, current).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            installSession?.requests.delete(req);
            return reject(new Error(`Download failed HTTP ${res.statusCode}`));
          }
          const total = Number(res.headers["content-length"] || 0);
          let received = 0;
          let lastEmit = 0;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const out = createWriteStream(dest);
          const onAbort = () => {
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
            try {
              out.destroy();
            } catch {
              /* ignore */
            }
            try {
              fs.unlinkSync(dest);
            } catch {
              /* ignore */
            }
            reject(new RuntimeCancelledError());
          };
          res.on("data", (chunk) => {
            if (installSession?.aborted) {
              onAbort();
              return;
            }
            received += chunk.length;
            const now = Date.now();
            if (onProgress && (now - lastEmit > 200 || received === total)) {
              lastEmit = now;
              onProgress(received, total);
            }
          });
          pipeline(res, out)
            .then(() => {
              installSession?.requests.delete(req);
              throwIfAborted();
              resolve();
            })
            .catch((err) => {
              installSession?.requests.delete(req);
              if (installSession?.aborted) reject(new RuntimeCancelledError());
              else reject(err);
            });
        }
      );
      installSession?.requests.add(req);
      req.on("timeout", () => {
        req.destroy(new Error("Download timed out"));
      });
      req.on("error", (err) => {
        installSession?.requests.delete(req);
        if (installSession?.aborted) reject(new RuntimeCancelledError());
        else reject(err);
      });
    };
    follow(url);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const follow = (current, redirects = 0) => {
      if (redirects > 8) return reject(new Error("Too many redirects"));
      const lib = current.startsWith("https") ? https : http;
      const req = lib.get(current, { headers: { "User-Agent": "OpenModelDB-Upscaler" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, current).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${current}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
    };
    follow(url);
  });
}

function detectCpTag(venvPy) {
  const r = runCapture(venvPy, [
    "-c",
    "import sys; print(f'cp{sys.version_info.major}{sys.version_info.minor}')",
  ]);
  const tag = String(r.stdout || "").trim();
  return /^cp\d+$/.test(tag) ? tag : "cp311";
}

/**
 * Pick latest matching wheel from a PEP 503 simple index page (PyTorch CUDA index).
 * uv won't stream byte progress without a TTY — we download large wheels ourselves instead.
 */
function pickWheelFromSimpleIndex(html, packageName, cpTag, plat = "win_amd64") {
  const hrefs = [...String(html).matchAll(/href=["']([^"']+\.whl[^"']*)["']/gi)].map((m) => m[1]);
  const names = hrefs.map((h) => {
    const raw = (h.split("/").pop() || h).split("#")[0];
    let file;
    try {
      file = decodeURIComponent(raw);
    } catch {
      file = raw;
    }
    return { href: h.split("#")[0], file };
  });
  const matches = names.filter(({ file }) => {
    const lower = file.toLowerCase();
    return (
      lower.startsWith(`${packageName.toLowerCase()}-`) &&
      lower.includes(`-${cpTag}-`) &&
      lower.includes(plat.toLowerCase()) &&
      lower.endsWith(".whl")
    );
  });
  if (!matches.length) return null;
  const preferred = matches.filter(({ file }) => /\+cu\d+/i.test(file) || /cu\d+/i.test(file));
  const pool = preferred.length ? preferred : matches;
  pool.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
  return pool[pool.length - 1];
}

function absolutizeUrl(base, href) {
  if (/^https?:\/\//i.test(href)) return href;
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(href, root).toString();
}

async function resolveCudaTorchWheels(venvPy, onLog) {
  const index = "https://download.pytorch.org/whl/cu128";
  const cpTag = detectCpTag(venvPy);
  onLog?.(`Resolving CUDA wheels for ${cpTag}-win_amd64 from ${index}…`);
  const out = [];
  for (const pkg of ["torch", "torchvision"]) {
    const pageUrl = `${index}/${pkg}/`;
    const html = await fetchText(pageUrl);
    const hit = pickWheelFromSimpleIndex(html, pkg, cpTag, "win_amd64");
    if (!hit) throw new Error(`No ${pkg} wheel for ${cpTag}-win_amd64 on CUDA index`);
    const url = absolutizeUrl(pageUrl, hit.href);
    out.push({ package: pkg, file: hit.file, url });
    onLog?.(`Found ${pkg} · ${hit.file}`);
  }
  return out;
}

async function downloadWheelsWithProgress(wheels, destDir, onLog, onProgress, stage = "torch") {
  fs.mkdirSync(destDir, { recursive: true });
  const paths = [];
  let completedBytes = 0;
  // Rough prior for torch+torchvision CUDA (UI only until Content-Length arrives).
  let plannedTotal = Math.round(2.8 * 1024 * 1024 * 1024);

  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i];
    const dest = path.join(destDir, w.file);
    if (exists(dest)) {
      const sz = fs.statSync(dest).size;
      if (sz > 1024 * 1024) {
        onLog?.(`Reusing cached wheel · ${w.file} (${formatBytes(sz)})`);
        completedBytes += sz;
        paths.push(dest);
        continue;
      }
    }
    onLog?.(`Downloading ${w.package} · ${w.file}`);
    onLog?.(`URL · ${w.url}`);
    let fileTotal = 0;
    await downloadFile(w.url, dest, (received, total) => {
      if (total > 0) fileTotal = total;
      const overall = completedBytes + received;
      const denom = Math.max(plannedTotal, completedBytes + (total || received));
      const pct = Math.min(88, 10 + Math.round((overall / denom) * 75));
      onProgress?.({
        stage,
        percent: pct,
        downloaded: overall,
        total: denom,
        expectedBytes: EXPECTED_RUNTIME_BYTES,
        packageName: w.package,
        message: `Downloading ${w.package}… ${formatBytes(received)}${
          total ? ` / ${formatBytes(total)}` : ""
        } (${i + 1}/${wheels.length})`,
      });
    });
    const sz = fs.statSync(dest).size;
    completedBytes += sz;
    if (fileTotal > 0 && i === 0) {
      // Refine remaining estimate after first wheel's size is known.
      plannedTotal = Math.max(plannedTotal, Math.round(completedBytes * (wheels.length === 1 ? 1 : 1.15)));
    }
    onLog?.(`Saved ${w.file} · ${formatBytes(sz)}`);
    paths.push(dest);
  }
  return paths;
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform !== "win32") throw new Error("Zip extract is Windows-only for now");
  const ps = [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ];
  const r = runCapture("powershell", ps, { timeout: 300000 });
  if (r.status !== 0) throw new Error(`Failed to extract zip: ${(r.stderr || r.stdout || "").trim()}`);
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

/** Cheap size estimate: only walk a limited number of entries (avoids thrashing disk during install). */
function dirSizeBytesBudgeted(root, maxFiles = 4000) {
  if (!exists(root)) return 0;
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (seen >= maxFiles) break;
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) {
          total += fs.statSync(full).size;
          seen += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

/** Newest file under root — helps detect silent downloads when size stalls. */
function newestFileActivity(root, maxFiles = 2500) {
  if (!root || !exists(root)) return null;
  let best = null;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (seen >= maxFiles) break;
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) {
          seen += 1;
          const st = fs.statSync(full);
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { path: full, size: st.size, mtimeMs: st.mtimeMs, name: ent.name };
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return best;
}

function parseInstallProgress(line) {
  const text = String(line || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!text) return null;

  const pct = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const ratio = text.match(
    /(\d+(?:\.\d+)?)\s*(Ki?B|Mi?B|Gi?B|KB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(Ki?B|Mi?B|Gi?B|KB|MB|GB)/i
  );
  const unitToBytes = (n, u) => {
    const x = Number(n);
    const U = String(u).toUpperCase();
    if (U.startsWith("G")) return x * 1073741824;
    if (U.startsWith("M")) return x * 1048576;
    if (U.startsWith("K")) return x * 1024;
    return x;
  };

  let downloaded = null;
  let total = null;
  let percent = null;
  if (ratio) {
    downloaded = unitToBytes(ratio[1], ratio[2]);
    total = unitToBytes(ratio[3], ratio[4]);
    if (total > 0) percent = Math.round((downloaded / total) * 100);
  } else if (pct) {
    percent = Math.round(Number(pct[1]));
  }

  const downloading = text.match(/download(?:ing|ed)?\s+([a-z0-9_.+-]+)/i);
  const installing = text.match(/install(?:ing|ed)?\s+([a-z0-9_.+-]+)/i);
  const packageName = downloading?.[1] || installing?.[1] || null;

  if (percent == null && !packageName && !/(download|install|resolv|fetch|torch|wheel)/i.test(text)) {
    return null;
  }

  return {
    raw: text,
    percent,
    downloaded,
    total,
    packageName,
    message: [
      packageName ? packageName : null,
      percent != null ? `${percent}%` : null,
      downloaded != null && total != null
        ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
        : downloaded != null
          ? formatBytes(downloaded)
          : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function spawnLogged(cmd, args, { onLog, onProgress, env, label, watchDirs = [] } = {}) {
  return new Promise((resolve, reject) => {
    throwIfAborted();
    const child = spawn(cmd, args, {
      windowsHide: true,
      env: {
        ...process.env,
        ...(env || {}),
        PYTHONUNBUFFERED: "1",
        // Progress bars need a TTY — leave progress enabled but don't set UV_NO_PROGRESS
        // (any value can disable bars). Rely on our own wheel downloads for torch bytes.
        UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || "300",
        UV_HTTP_RETRIES: process.env.UV_HTTP_RETRIES || "5",
        RUST_LOG: process.env.RUST_LOG || "uv=info",
        UV_CONCURRENT_DOWNLOADS: process.env.UV_CONCURRENT_DOWNLOADS || "8",
        UV_CONCURRENT_EXTRACTS: process.env.UV_CONCURRENT_EXTRACTS || "4",
      },
    });
    installSession?.children.add(child);

    let buffer = "";
    let lastLogAt = Date.now();
    let lastProgressAt = 0;
    let lastWatchBytes = 0;
    let lastWatchAt = 0;
    let lastGrowthAt = Date.now();
    let lastActivityKey = "";
    let skipSpam = 0;
    let stallWarned = false;
    const startedAt = Date.now();

    const emitProgress = (payload) => {
      lastProgressAt = Date.now();
      onProgress?.(payload);
    };

    const handleChunk = (buf) => {
      buffer += buf.toString("utf8");
      // uv progress often rewrites the same line with \r only.
      const parts = buffer.split(/\r|\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!line) continue;
        lastLogAt = Date.now();

        // Don't flood the UI with thousands of "Skipping file" lines (burns CPU).
        if (/Skipping file for /i.test(line)) {
          skipSpam += 1;
          if (skipSpam === 1 || skipSpam % 100 === 0) {
            onLog?.(`resolving… skipped ${skipSpam} incompatible wheels (normal)`);
          }
          continue;
        }

        onLog?.(line);
        const parsed = parseInstallProgress(line);
        if (parsed) {
          const pct =
            parsed.downloaded != null
              ? Math.min(95, Math.round((parsed.downloaded / EXPECTED_RUNTIME_BYTES) * 100))
              : parsed.percent;
          emitProgress({
            stage: label || "install",
            percent: pct,
            downloaded: parsed.downloaded,
            total: parsed.total || EXPECTED_RUNTIME_BYTES,
            expectedBytes: EXPECTED_RUNTIME_BYTES,
            packageName: parsed.packageName,
            message: parsed.message || line.slice(0, 160),
            raw: line.slice(0, 200),
          });
        }
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    // Disk sampling is intentionally rare — full recursive scans fight the installer for I/O.
    const heartbeat = setInterval(() => {
      if (child.exitCode != null) return;
      if (installSession?.aborted) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        return;
      }
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const now = Date.now();

      if (watchDirs.length && now - lastWatchAt > 8000) {
        lastWatchAt = now;
        let watchBytes = 0;
        for (const dir of watchDirs) watchBytes += dirSizeBytesBudgeted(dir, 4000);

        let activity = null;
        for (const dir of watchDirs) {
          const hit = newestFileActivity(dir, 2500);
          if (hit && (!activity || hit.mtimeMs > activity.mtimeMs)) activity = hit;
        }

        const grew = watchBytes > lastWatchBytes + 256 * 1024;
        if (grew) {
          lastWatchBytes = watchBytes;
          lastGrowthAt = now;
          stallWarned = false;
          const pct = Math.min(95, Math.round((watchBytes / EXPECTED_RUNTIME_BYTES) * 100));
          emitProgress({
            stage: label || "install",
            percent: pct,
            message: `Writing packages… ${formatBytes(watchBytes)} / ${EXPECTED_RUNTIME_LABEL} (~${pct}%) · ${elapsedSec}s`,
            downloaded: watchBytes,
            total: EXPECTED_RUNTIME_BYTES,
            expectedBytes: EXPECTED_RUNTIME_BYTES,
            diskBytes: watchBytes,
            elapsedSec,
          });
          onLog?.(
            `progress · ${formatBytes(watchBytes)} / ${EXPECTED_RUNTIME_LABEL} (~${pct}%) · ${elapsedSec}s`
          );
        }

        if (activity) {
          const ageSec = Math.max(0, Math.round((now - activity.mtimeMs) / 1000));
          const key = `${activity.name}:${activity.size}:${Math.floor(activity.mtimeMs / 5000)}`;
          if (key !== lastActivityKey) {
            lastActivityKey = key;
            lastLogAt = now;
            onLog?.(
              `cache file · ${activity.name} · ${formatBytes(activity.size)} · touched ${ageSec}s ago`
            );
            if (ageSec < 15) lastGrowthAt = now;
          }
        }

        if (!grew && now - lastGrowthAt > 90000 && !stallWarned) {
          stallWarned = true;
          onLog?.(
            `warning · no disk growth for ${Math.round((now - lastGrowthAt) / 1000)}s during ${label || "install"} — likely waiting on network (pytorch.org / PyPI). Check VPN/firewall; large CUDA wheels are ~2+ GB.`
          );
        }

        if (grew) return;
      }

      if (now - lastLogAt > 10000 && now - lastProgressAt > 10000) {
        const pct = lastWatchBytes
          ? Math.min(95, Math.round((lastWatchBytes / EXPECTED_RUNTIME_BYTES) * 100))
          : null;
        emitProgress({
          stage: label || "install",
          percent: pct,
          message: `Still working… ${
            lastWatchBytes
              ? `${formatBytes(lastWatchBytes)} / ${EXPECTED_RUNTIME_LABEL}`
              : "download/extract in progress"
          } · ${elapsedSec}s`,
          downloaded: lastWatchBytes || undefined,
          total: EXPECTED_RUNTIME_BYTES,
          expectedBytes: EXPECTED_RUNTIME_BYTES,
          diskBytes: lastWatchBytes || undefined,
          elapsedSec,
        });
        onLog?.(
          `still working… on-disk cache ${
            lastWatchBytes ? formatBytes(lastWatchBytes) : "unchanged"
          } · ${elapsedSec}s · stage:${label || "install"} — uv often stays quiet until a file finishes; this is not always a freeze`
        );
        lastProgressAt = now;
      }
    }, 3000);

    child.on("error", (err) => {
      clearInterval(heartbeat);
      installSession?.children.delete(child);
      reject(installSession?.aborted ? new RuntimeCancelledError() : err);
    });
    child.on("exit", (code) => {
      clearInterval(heartbeat);
      installSession?.children.delete(child);
      if (skipSpam > 0) onLog?.(`resolve done · skipped ${skipSpam} incompatible wheels`);
      if (buffer.trim()) {
        onLog?.(buffer.trim());
        buffer = "";
      }
      if (installSession?.aborted) {
        reject(new RuntimeCancelledError());
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(String(cmd))} exited with ${code}`));
    });
  });
}

async function ensureUv(toolsDir, onLog, onProgress) {
  const uvExe = path.join(toolsDir, "uv.exe");
  if (exists(uvExe)) return uvExe;
  if (!UV_ZIP) throw new Error("Automatic runtime install is currently Windows-only");

  onLog?.("Downloading uv (Astral) — standard Python tooling…");
  const zipPath = path.join(toolsDir, "uv.zip");
  await downloadFile(UV_ZIP, zipPath, (received, total) => {
    onProgress?.({
      stage: "download-uv",
      percent: total ? Math.round((received / total) * 100) : null,
      downloaded: received,
      total: total || null,
      message: total
        ? `Downloading uv… ${formatBytes(received)} / ${formatBytes(total)}`
        : `Downloading uv… ${formatBytes(received)}`,
    });
  });
  onLog?.("Extracting uv…");
  extractZip(zipPath, toolsDir);
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }
  if (!exists(uvExe)) {
    for (const name of fs.readdirSync(toolsDir)) {
      const p = path.join(toolsDir, name, "uv.exe");
      if (exists(p)) {
        fs.copyFileSync(p, uvExe);
        break;
      }
    }
  }
  if (!exists(uvExe)) throw new Error("uv.exe missing after download");
  return uvExe;
}

async function installTorchAndDeps(
  uv,
  venvPy,
  requirementsFile,
  onLog,
  onProgress,
  cacheDir,
  { skipTorch = false, skipRequirements = false } = {}
) {
  const sitePackages = path.join(path.dirname(venvPy), "..", "Lib", "site-packages");
  const watchDirs = [sitePackages, cacheDir].filter(Boolean);
  const v = ["-v"];
  const wheelDir = path.join(cacheDir, "wheels");

  onProgress?.({ stage: "pip", percent: 5, message: "Installing pip tooling…" });
  await spawnLogged(
    uv,
    [...v, "pip", "install", "--python", venvPy, "pip", "wheel", "setuptools"],
    { onLog, onProgress, label: "pip", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
  );

  if (!skipTorch) {
    onProgress?.({
      stage: "torch",
      percent: 8,
      message: `Downloading PyTorch CUDA wheels (metered) — final env ≈ ${EXPECTED_RUNTIME_LABEL}`,
      total: EXPECTED_RUNTIME_BYTES,
      expectedBytes: EXPECTED_RUNTIME_BYTES,
    });
    onLog?.(
      `PyTorch CUDA wheels are large (~2+ GB). We download them directly so the progress bar can move; uv alone hides byte progress without a terminal.`
    );
    onLog?.(`Download cache · ${cacheDir}`);

    try {
      const wheels = await resolveCudaTorchWheels(venvPy, onLog);
      const localWheels = await downloadWheelsWithProgress(
        wheels,
        wheelDir,
        onLog,
        onProgress,
        "torch"
      );
      onProgress?.({
        stage: "torch",
        percent: 90,
        message: "Installing downloaded wheels into the venv…",
        expectedBytes: EXPECTED_RUNTIME_BYTES,
      });
      onLog?.("Installing local wheels with uv…");
      await spawnLogged(
        uv,
        [...v, "pip", "install", "--python", venvPy, ...localWheels],
        { onLog, onProgress, label: "torch-install", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
      );
    } catch (err) {
      onLog?.(`Metered CUDA wheel download failed (${err.message}) — falling back to uv index install…`);
      try {
        await spawnLogged(
          uv,
          [
            ...v,
            "pip",
            "install",
            "--python",
            venvPy,
            "torch",
            "torchvision",
            "--index-url",
            "https://download.pytorch.org/whl/cu128",
          ],
          { onLog, onProgress, label: "torch", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
        );
      } catch (err2) {
        onLog?.(`CUDA index failed (${err2.message}) — falling back to default PyPI torch…`);
        await spawnLogged(
          uv,
          [...v, "pip", "install", "--python", venvPy, "torch", "torchvision"],
          { onLog, onProgress, label: "torch-cpu", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
        );
      }
    }
  } else {
    onLog?.("Skipping torch download — already present in this environment.");
  }

  if (!skipRequirements) {
    onProgress?.({ stage: "deps", percent: 92, message: "Installing Spandrel + image libs…" });
    if (!exists(requirementsFile)) throw new Error(`requirements.txt missing: ${requirementsFile}`);
    await spawnLogged(
      uv,
      [...v, "pip", "install", "--python", venvPy, "-r", requirementsFile],
      { onLog, onProgress, label: "deps", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
    );
  }
}

/** Install only the named packages into an existing interpreter. */
async function installPackagesInto(
  uv,
  pythonExe,
  packages,
  onLog,
  onProgress,
  cacheDir,
  { needTorch = false, requirementsFile = null } = {}
) {
  const sitePackages = path.join(path.dirname(pythonExe), "..", "Lib", "site-packages");
  const watchDirs = [sitePackages, cacheDir].filter(Boolean);
  const v = ["-v"];

  if (needTorch) {
    await installTorchAndDeps(uv, pythonExe, requirementsFile, onLog, onProgress, cacheDir, {
      skipTorch: false,
      skipRequirements: true,
    });
  }

  const light = packages.filter((p) => !/^torch(vision)?$/i.test(p));
  if (light.length) {
    onProgress?.({
      stage: "deps",
      percent: needTorch ? 92 : 40,
      message: `Installing missing: ${light.join(", ")}`,
    });
    onLog?.(`Installing into ${pythonExe}: ${light.join(", ")}`);
    await spawnLogged(
      uv,
      [...v, "pip", "install", "--python", pythonExe, ...light],
      { onLog, onProgress, label: "missing", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
    );
  }

  // Only pull full requirements when we also had to bring torch (new-ish env).
  // Avoid `-r` on a rich ComfyUI env — it can churn existing CUDA wheels.
  if (needTorch && requirementsFile && exists(requirementsFile)) {
    onLog?.("Ensuring remaining requirements…");
    await spawnLogged(
      uv,
      [...v, "pip", "install", "--python", pythonExe, "-r", requirementsFile],
      { onLog, onProgress, label: "deps", watchDirs, env: { UV_CACHE_DIR: cacheDir } }
    );
  }
}

/**
 * Ensure a working runtime. Reuses system torch/spandrel when possible.
 * Otherwise creates an isolated AppData venv (good practice) using the user's
 * Python as the base when available.
 */
async function bootstrapRuntime(opts) {
  const {
    userDataDir,
    downloadCacheDir,
    onLog,
    onProgress,
  } = opts;
  beginInstallSession({ userDataDir, downloadCacheDir });
  try {
    return await bootstrapRuntimeInner(opts);
  } catch (err) {
    if (err?.cancelled || err instanceof RuntimeCancelledError || installSession?.aborted) {
      onLog?.("Runtime install cancelled — cleaning incomplete venv + download cache…");
      clearInstallArtifacts({ userDataDir, downloadCacheDir, onLog });
      onProgress?.({ stage: "cancelled", percent: 0, message: "Runtime install cancelled" });
      throw new RuntimeCancelledError();
    }
    throw err;
  } finally {
    endInstallSession();
  }
}

/**
 * Ensure a working runtime. Reuses system torch/spandrel when possible.
 * Otherwise creates an isolated AppData venv (good practice) using the user's
 * Python as the base when available.
 */
async function bootstrapRuntimeInner({
  userDataDir,
  downloadCacheDir,
  projectPythonDir,
  resourcesDir,
  requirementsFile,
  customPython = "",
  installTarget = "appdata",
  onLog,
  onProgress,
}) {
  const report = diagnoseEnvironment({
    userDataDir,
    downloadCacheDir,
    projectPythonDir,
    resourcesDir,
    requirementsFile,
    customPython,
  });

  for (const step of report.steps) {
    onLog?.(`[${step.status}] ${step.title}`);
    if (step.detail) {
      for (const line of String(step.detail).split("\n")) onLog?.(`  ${line}`);
    }
  }

  const cacheDir =
    downloadCacheDir ||
    path.join(require("os").homedir(), "Downloads", "OpenModelDB-Upscaler-Cache");

  if (report.preferred) {
    onProgress?.({
      stage: "done",
      percent: 100,
      message: `Using existing runtime · ${report.preferred.executable}`,
    });
    onLog?.(`Reusing: ${report.preferred.executable}`);
    const cleared = clearDownloadCache(cacheDir, onLog);
    return {
      python: report.preferred.executable,
      already: true,
      source: report.preferred.kind,
      cacheCleared: cleared,
      diagnosis: diagnoseEnvironment({
        userDataDir,
        downloadCacheDir: cacheDir,
        projectPythonDir,
        resourcesDir,
        requirementsFile,
        customPython,
      }),
    };
  }

  const root = path.join(userDataDir, "python");
  const toolsDir = path.join(root, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const uv = await ensureUv(toolsDir, onLog, onProgress);
  throwIfAborted();

  const selected = report.customCandidate;
  const target = installTarget === "selected" ? "selected" : "appdata";

  // --- Install missing packages into the selected environment ---
  if (target === "selected" && selected?.executable && selected.version) {
    onLog?.(`Install target: selected environment`);
    onLog?.(`Python: ${selected.executable}`);
    onLog?.(`Missing: ${(selected.missing || []).join(", ") || "(none listed)"}`);
    const needTorch = !selected.torch;
    await installPackagesInto(
      uv,
      selected.executable,
      selected.missing || [],
      onLog,
      onProgress,
      cacheDir,
      { needTorch, requirementsFile }
    );
    throwIfAborted();
    const check = inspectPython(selected.executable);
    if (!check?.ready) {
      throw new Error(
        `Selected env still incomplete after install. Missing: ${(check?.missing || []).join(", ") || "unknown"}`
      );
    }
    onProgress?.({ stage: "done", percent: 100, message: "AI runtime ready (selected env)" });
    onLog?.(`Runtime ready: ${selected.executable}`);
    const cleared = clearDownloadCache(cacheDir, onLog);
    return {
      python: selected.executable,
      already: false,
      source: "custom",
      cacheCleared: cleared,
      diagnosis: diagnoseEnvironment({
        userDataDir,
        downloadCacheDir: cacheDir,
        projectPythonDir,
        resourcesDir,
        requirementsFile,
        customPython,
      }),
    };
  }

  // --- Default: isolated AppData venv ---
  const venvDir = path.join(root, ".venv");
  const venvPy = venvPythonPath(venvDir);
  onProgress?.({ stage: "start", percent: 2, message: "Preparing isolated AppData venv…" });
  onLog?.(`Install target: AppData (isolated)`);
  onLog?.(`Download cache (wheels): ${cacheDir}`);
  onLog?.(`Final venv (AppData): ${venvDir}`);
  if (selected?.executable) {
    onLog?.(
      "Note: AppData is isolated — it will not reuse packages already in your selected env (torch may download again)."
    );
  }
  onLog?.(
    "Tip: if Windows Defender slows this down, exclude the download cache folder above (not your whole Downloads)."
  );

  if (exists(venvDir)) {
    onLog?.(`Removing incomplete venv: ${venvDir}`);
    fs.rmSync(venvDir, { recursive: true, force: true });
  }

  const uvEnv = { UV_CACHE_DIR: cacheDir };
  const baseExe = report.baseForInstall?.executable || null;

  if (baseExe) {
    onProgress?.({
      stage: "venv",
      percent: 8,
      message: `Creating venv from ${baseExe}`,
    });
    onLog?.(`Using Python as base: ${baseExe}`);
    await spawnLogged(uv, ["venv", venvDir, "--python", baseExe], {
      onLog,
      onProgress,
      label: "venv",
      env: uvEnv,
    });
  } else {
    onProgress?.({ stage: "python", percent: 5, message: "Installing Python 3.11 via uv…" });
    await spawnLogged(uv, ["python", "install", "3.11"], {
      onLog,
      onProgress,
      label: "python",
      env: uvEnv,
      watchDirs: [cacheDir],
    });
    onProgress?.({ stage: "venv", percent: 8, message: "Creating AppData venv…" });
    await spawnLogged(uv, ["venv", venvDir, "--python", "3.11"], {
      onLog,
      onProgress,
      label: "venv",
      env: uvEnv,
    });
  }

  throwIfAborted();
  if (!exists(venvPy)) throw new Error(`venv python missing: ${venvPy}`);
  onLog?.(`App venv python: ${venvPy}`);

  await installTorchAndDeps(uv, venvPy, requirementsFile, onLog, onProgress, cacheDir);
  throwIfAborted();

  const check = inspectPython(venvPy);
  if (!check?.ready) {
    throw new Error("Runtime installed but torch/spandrel import check failed");
  }

  onProgress?.({ stage: "done", percent: 100, message: "AI runtime ready" });
  onLog?.(`Runtime ready: ${venvPy}`);
  const cleared = clearDownloadCache(cacheDir, onLog);
  return {
    python: venvPy,
    already: false,
    source: "app-venv",
    cacheCleared: cleared,
    diagnosis: diagnoseEnvironment({
      userDataDir,
      downloadCacheDir: cacheDir,
      projectPythonDir,
      resourcesDir,
      requirementsFile,
      customPython,
    }),
  };
}

module.exports = {
  inspectPython,
  diagnoseEnvironment,
  bootstrapRuntime,
  cancelRuntimeInstall,
  clearInstallArtifacts,
  resolveEnvPython,
  RuntimeCancelledError,
  venvPythonPath,
  dirSizeBytesBudgeted,
  EXPECTED_RUNTIME_BYTES,
  EXPECTED_RUNTIME_LABEL,
};

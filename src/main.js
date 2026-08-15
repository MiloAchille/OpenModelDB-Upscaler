const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, dialog, shell, net, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const Store = require("electron-store");

const store = new Store({
  name: "settings",
  defaults: {
    lastModel: "",
    lastFormat: "png",
    mode: "factor",
    factor: 4,
    longest: 2048,
    tile: 256,
  },
});

const OMDB_API = "https://openmodeldb.info/api/v1/models.json";
const OMDB_BASE = "https://openmodeldb.info";

let mainWindow = null;
let omdbCache = null;
let omdbFetchedAt = 0;
let activeJob = null;

function isDev() {
  return process.argv.includes("--dev") || !app.isPackaged;
}

function appRoot() {
  return isDev() ? path.join(__dirname, "..") : path.dirname(app.getAppPath());
}

function modelsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "models");
  }
  return path.join(appRoot(), "models");
}

function userModelsDir() {
  const dir = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pythonScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python", "upscale.py");
  }
  return path.join(appRoot(), "python", "upscale.py");
}

function resolvePython() {
  const localVenv = path.join(
    app.isPackaged ? process.resourcesPath : appRoot(),
    "python",
    ".venv",
    process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"
  );
  const userVenv = path.join(
    app.getPath("userData"),
    "python",
    ".venv",
    process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"
  );
  const candidates = [
    process.env.UPSCALER_PYTHON,
    userVenv,
    localVenv,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function listLocalModels() {
  const dirs = [modelsDir(), userModelsDir()];
  const seen = new Set();
  const models = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(pth|pt|ckpt|safetensors)$/i.test(name)) continue;
      const full = path.join(dir, name);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const stat = fs.statSync(full);
      const suspicious = isSuspiciousModelFile(full, stat.size);
      models.push({
        id: name,
        name,
        path: full,
        size: stat.size,
        mtime: stat.mtimeMs,
        builtin: dir === modelsDir(),
        suspicious,
        offlineReady: !suspicious,
      });
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

function isHtmlBuffer(buf) {
  if (!buf || buf.length < 16) return false;
  const head = buf.slice(0, 256).toString("utf8").trim().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.includes("<html") ||
    head.includes("google drive") && head.includes("<!doctype")
  );
}

function isSuspiciousModelFile(filePath, size) {
  try {
    if (!size || size < 512 * 1024) {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(Math.min(512, size || 0));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (isHtmlBuffer(buf)) return true;
      if (size < 256 * 1024) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function gdriveFileId(url) {
  const u = String(url || "");
  let m = u.match(/\/file\/d\/([^/]+)/i);
  if (m) return m[1];
  m = u.match(/[?&]id=([^&]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function gdriveDirectUrl(id, confirm = "t", uuid = null) {
  let url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    id
  )}&export=download&confirm=${encodeURIComponent(confirm)}`;
  if (uuid) url += `&uuid=${encodeURIComponent(uuid)}`;
  return url;
}

function normalizeDownloadUrl(url) {
  const id = gdriveFileId(url);
  // Prefer the usercontent endpoint with confirm=t — avoids the HTML interstitial for many files.
  if (id) return gdriveDirectUrl(id, "t");
  return url;
}

function urlPriority(url) {
  const u = String(url || "").toLowerCase();
  if (/objectstorage|huggingface\.co|hf\.co|github\.com\/.*releases\/download|raw\.githubusercontent/.test(u)) {
    return 0;
  }
  if (/drive\.usercontent\.google\.com|drive\.google\.com/.test(u)) return 2;
  if (/mega\.nz|mega\.co\.nz/i.test(u)) return 3;
  if (/mediafire\.com/.test(u)) return 5;
  return 1;
}

function sortDownloadUrls(urls) {
  return [...new Set((urls || []).filter(Boolean))].sort(
    (a, b) => urlPriority(a) - urlPriority(b)
  );
}

function isWeightFilename(name) {
  return /\.(pth|pt|ckpt|safetensors)$/i.test(String(name || ""));
}

function pickMegaFile(root, preferredName) {
  if (!root) return null;
  if (!root.directory && isWeightFilename(root.name)) return root;
  if (!root.directory && root.size > 0 && !root.children) return root;

  const children = Array.isArray(root.children) ? root.children : [];
  const flat = [];
  const walk = (node) => {
    if (!node) return;
    if (node.directory && Array.isArray(node.children)) {
      node.children.forEach(walk);
      return;
    }
    flat.push(node);
  };
  children.forEach(walk);
  if (!flat.length && !root.directory) return root;

  const preferred = String(preferredName || "").toLowerCase();
  if (preferred) {
    const exact = flat.find((f) => String(f.name || "").toLowerCase() === preferred);
    if (exact) return exact;
    const partial = flat.find((f) =>
      preferred.includes(String(f.name || "").toLowerCase()) ||
      String(f.name || "").toLowerCase().includes(preferred.replace(/\.(pth|pt|ckpt|safetensors)$/i, ""))
    );
    if (partial) return partial;
  }
  const weights = flat.filter((f) => isWeightFilename(f.name));
  if (weights.length) {
    weights.sort((a, b) => (b.size || 0) - (a.size || 0));
    return weights[0];
  }
  flat.sort((a, b) => (b.size || 0) - (a.size || 0));
  return flat[0] || null;
}

async function fetchFromMega(url, destPath, onProgress, preferredName) {
  let File;
  try {
    ({ File } = require("megajs"));
  } catch (err) {
    throw new Error(`MEGA support missing (${err.message}). Reinstall dependencies.`);
  }

  const root = File.fromURL(url);
  const loaded = await root.loadAttributes();
  const file = pickMegaFile(loaded && loaded.name ? loaded : root, preferredName);
  if (!file) throw new Error("No downloadable file found in MEGA link");

  await new Promise((resolve, reject) => {
    const stream = file.download({ maxConnections: 4 });
    const out = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.on("progress", (info) => {
      if (onProgress) onProgress(info.bytesLoaded || 0, info.bytesTotal || file.size || 0);
    });
    stream.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    stream.pipe(out);
  });

  const size = fs.statSync(destPath).size;
  return { size, url, name: file.name || preferredName };
}

function parseGdriveConfirm(html) {
  const confirm =
    html.match(/confirm=([0-9A-Za-z_]+)/)?.[1] ||
    html.match(/name="confirm"\s+value="([^"]+)"/)?.[1] ||
    "t";
  const uuid = html.match(/name="uuid"\s+value="([^"]+)"/)?.[1];
  const id = html.match(/name="id"\s+value="([^"]+)"/)?.[1];
  return { confirm, uuid, id };
}

function looksLikeHtml(contentType, sample) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html")) return true;
  return isHtmlBuffer(sample);
}

async function fetchToFile(url, destPath, onProgress, opts = {}) {
  const allowConfirm = opts.allowConfirm !== false;
  const res = await net.fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  const total = Number(res.headers.get("content-length") || 0);
  const isLikelyHtml =
    contentType.includes("text/html") || (total > 0 && total < 512 * 1024);

  // Stream large binaries to disk. Buffer small responses (HTML interstitials).
  if (!isLikelyHtml && res.body && typeof res.body.getReader === "function") {
    const file = fs.createWriteStream(destPath);
    const reader = res.body.getReader();
    let received = 0;
    const sample = [];
    let sampleLen = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (sampleLen < 512) {
          sample.push(buf);
          sampleLen += buf.byteLength;
        }
        if (!file.write(buf)) {
          await new Promise((r) => file.once("drain", r));
        }
        received += buf.byteLength;
        if (onProgress) onProgress(received, total || Math.max(received, 1));
      }
    } finally {
      await new Promise((resolve, reject) => {
        file.end((err) => (err ? reject(err) : resolve()));
      });
    }

    const head = Buffer.concat(sample).slice(0, 512);
    if (looksLikeHtml(contentType, head) || received < 512 * 1024) {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      if (allowConfirm && /drive\.google|drive\.usercontent\.google/i.test(url)) {
        return fetchGdriveWithConfirm(url, destPath, onProgress);
      }
      throw new Error("Download looked like a webpage, not a model file");
    }
    return { size: received, contentType };
  }

  // Buffered path (small responses / HTML).
  const chunks = [];
  let received = 0;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      received += buf.byteLength;
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    chunks.push(buf);
    received = buf.length;
  }

  const data = Buffer.concat(chunks);
  if (looksLikeHtml(contentType, data) && allowConfirm && /drive\.google|drive\.usercontent\.google/i.test(url)) {
    return fetchGdriveWithConfirm(url, destPath, onProgress, data.toString("utf8"));
  }
  if (looksLikeHtml(contentType, data)) {
    throw new Error("Download looked like a webpage, not a model file");
  }

  fs.writeFileSync(destPath, data);
  if (onProgress) onProgress(data.length, data.length);
  return { size: data.length, contentType };
}

async function fetchGdriveWithConfirm(url, destPath, onProgress, html = null) {
  const fileId = gdriveFileId(url);
  if (!fileId) throw new Error("Could not parse Google Drive file id");

  let confirm = "t";
  let uuid = null;
  if (html) {
    const parsed = parseGdriveConfirm(html);
    confirm = parsed.confirm || "t";
    uuid = parsed.uuid || null;
  }

  const candidates = [
    gdriveDirectUrl(fileId, "t"),
    gdriveDirectUrl(fileId, confirm, uuid),
    `https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(confirm)}&id=${encodeURIComponent(fileId)}${
      uuid ? `&uuid=${encodeURIComponent(uuid)}` : ""
    }`,
  ];

  let lastError = null;
  for (const next of [...new Set(candidates)]) {
    try {
      return await fetchToFile(next, destPath, onProgress, { allowConfirm: false });
    } catch (err) {
      lastError = err;
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    }
  }
  throw (
    lastError ||
    new Error(
      "Google Drive blocked automatic download. Open the model webpage and use Import model with the real .pth file."
    )
  );
}
async function downloadModelFile({ id, urls, filename, expectedSize, sha256, onProgress }) {
  const candidates = sortDownloadUrls(urls.map(normalizeDownloadUrl));
  if (!candidates.length) throw new Error("No download URL");

  const safeName =
    filename ||
    path.basename(String(new URL(candidates[0]).pathname || "")) ||
    `${id}.pth`;
  const dest = path.join(userModelsDir(), safeName.replace(/[<>:"|?*]/g, "_"));
  const partial = `${dest}.partial`;
  if (fs.existsSync(partial)) fs.unlinkSync(partial);

  let lastError = null;
  for (const url of candidates) {
    if (/mediafire\.com/i.test(url)) {
      lastError = new Error(
        `Host not supported for automatic download (${new URL(url).hostname}). Open the model page and import the file manually.`
      );
      continue;
    }
    try {
      if (onProgress) onProgress(0, expectedSize || 0);
      const result = /mega\.nz|mega\.co\.nz/i.test(url)
        ? await fetchFromMega(url, partial, onProgress, safeName)
        : await fetchToFile(url, partial, onProgress);
      if (expectedSize && expectedSize > 1024 * 1024) {
        const ratio = result.size / expectedSize;
        if (ratio < 0.85 || ratio > 1.15) {
          throw new Error(
            `Downloaded size ${result.size} does not match expected ${expectedSize}`
          );
        }
      } else if (result.size < 512 * 1024) {
        throw new Error(`Downloaded file too small (${result.size} bytes)`);
      }

      if (sha256) {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(partial);
        await new Promise((resolve, reject) => {
          stream.on("data", (chunk) => hash.update(chunk));
          stream.on("error", reject);
          stream.on("end", resolve);
        });
        const dig = hash.digest("hex");
        if (dig.toLowerCase() !== String(sha256).toLowerCase()) {
          throw new Error("SHA256 mismatch — download corrupted or wrong file");
        }
      }

      fs.renameSync(partial, dest);
      return { path: dest, name: path.basename(dest), size: fs.statSync(dest).size, url };
    } catch (err) {
      lastError = err;
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
    }
  }

  throw lastError || new Error("All download URLs failed");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1020,
    minHeight: 720,
    backgroundColor: "#0c0c0e",
    title: "OpenModelDB Upscaler",
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function fetchOmdb(force = false) {
  const fresh = Date.now() - omdbFetchedAt < 60 * 60 * 1000;
  if (omdbCache && fresh && !force) return omdbCache;
  const res = await net.fetch(OMDB_API);
  if (!res.ok) throw new Error(`OpenModelDB HTTP ${res.status}`);
  omdbCache = await res.json();
  omdbFetchedAt = Date.now();
  return omdbCache;
}

function summarizeModel(id, data) {
  const images = Array.isArray(data.images) ? data.images : [];
  let preview = null;
  let lr = null;
  let sr = null;

  const abs = (u) => {
    if (!u) return null;
    if (String(u).startsWith("http")) return u;
    return `${OMDB_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
  };

  for (const img of images) {
    if (img.type === "paired" || (img.LR && img.SR)) {
      lr = abs(img.LR);
      sr = abs(img.SR);
      preview = abs(img.thumbnail) || sr || lr;
      break;
    }
  }
  if (!preview) {
    for (const img of images) {
      if (img.thumbnail) {
        preview = abs(img.thumbnail);
        break;
      }
      if (img.SR) {
        preview = abs(img.SR);
        sr = abs(img.SR);
        lr = abs(img.LR) || lr;
        break;
      }
      if (img.url) {
        preview = abs(img.url);
        break;
      }
    }
  }

  // Prefer thumbnail pair from site when available (small/fast).
  const thumb = images.find((img) => img && img.thumbnail);
  const resources = Array.isArray(data.resources) ? data.resources : [];
  const pytorchResources = resources.filter(
    (r) =>
      r &&
      (r.type === "pth" || r.type === "safetensors" || r.platform === "pytorch") &&
      Array.isArray(r.urls) &&
      r.urls.length
  );
  const pytorch = pytorchResources[0] || null;
  const downloadUrls = pytorch
    ? [...new Set(pytorchResources.flatMap((r) => r.urls || []))]
    : [];

  const { description, githubUrl } = cleanOmdbDescription(data.description || "", downloadUrls);

  return {
    id,
    name: data.name || id,
    author: data.author || "",
    architecture: data.architecture || "",
    scale: data.scale || null,
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 6) : [],
    description,
    githubUrl,
    license: data.license || "",
    preview,
    lr,
    sr,
    thumbnail: thumb ? abs(thumb.thumbnail) : null,
    downloadUrl: downloadUrls[0] || null,
    downloadUrls,
    size: pytorch?.size || null,
    sha256: pytorch?.sha256 || null,
    resourceType: pytorch?.type || null,
    pageUrl: `${OMDB_BASE}/models/${encodeURIComponent(id)}`,
  };
}

/** Strip release-link boilerplate; keep real prose; extract a GitHub URL when present. */
function cleanOmdbDescription(raw, downloadUrls = []) {
  const text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n");

  let githubUrl = null;
  const mdLinks = [...text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi)];
  for (const m of mdLinks) {
    const label = m[1].toLowerCase();
    const url = m[2];
    if (/github\.com/i.test(url) || /github|release/i.test(label)) {
      githubUrl = url;
      break;
    }
  }
  if (!githubUrl) {
    const bare = text.match(/https?:\/\/github\.com\/[^\s)\]>"']+/i);
    if (bare) githubUrl = bare[0].replace(/[.,;]+$/, "");
  }
  if (!githubUrl) {
    const fromDl = (downloadUrls || []).find((u) => /github\.com/i.test(String(u)));
    if (fromDl) {
      const m = String(fromDl).match(
        /^(https?:\/\/github\.com\/[^/]+\/[^/]+\/releases)\/download\/([^/]+)\//i
      );
      githubUrl = m ? `${m[1]}/${m[2]}` : String(fromDl);
    }
  }

  let body = text;
  const descMatch = text.match(/(?:^|\n)\s*Description\s*:\s*([\s\S]+)/i);
  if (descMatch) {
    body = descMatch[1];
  } else {
    // Drop leading "Link to Github Release" markdown / similar link-only lines.
    body = text
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (!t) return false;
        if (/^\[?\s*link to github/i.test(t)) return false;
        if (/^https?:\/\/github\.com\S*$/i.test(t)) return false;
        // Skip key: value metadata blocks that often precede the prose.
        if (/^(Name|License|Author|Network|Network Option|Scale|Release Date|Purpose|Iterations|epoch|batch_size|HR_size|Dataset|Number of train images|OTF Training|Pretrained_Model_G)\s*:/i.test(t)) {
          return false;
        }
        return true;
      })
      .join("\n");
  }

  let description = body
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(Link to Github(?: Release)?(?: Name)?[:\s-]*)+/i, "")
    .trim();

  if (!description) {
    const purpose = text.match(/(?:^|\n)\s*Purpose\s*:\s*(.+)/i);
    description = purpose ? purpose[1].trim() : "";
  }
  if (description.length > 160) description = `${description.slice(0, 159)}…`;

  return { description, githubUrl };
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("get-settings", () => store.store);

ipcMain.handle("set-settings", (_e, partial) => {
  for (const [k, v] of Object.entries(partial || {})) store.set(k, v);
  return store.store;
});

ipcMain.handle("list-models", () => listLocalModels());

ipcMain.handle("delete-model", async (_e, modelPath) => {
  if (!modelPath || typeof modelPath !== "string") throw new Error("Invalid model path");
  const resolved = path.resolve(modelPath);
  const allowedRoots = [path.resolve(modelsDir()), path.resolve(userModelsDir())];
  const ok = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!ok) throw new Error("Model is outside managed folders");
  if (!fs.existsSync(resolved)) throw new Error("Model not found");
  fs.unlinkSync(resolved);
  return { ok: true, path: resolved };
});

ipcMain.handle("import-model", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import model",
    properties: ["openFile"],
    filters: [
      {
        name: "Model weights",
        extensions: ["pth", "pt", "ckpt", "safetensors"],
      },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const src = result.filePaths[0];
  const destDir = userModelsDir();
  let dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) {
    const stem = path.basename(src, path.extname(src));
    const ext = path.extname(src);
    dest = path.join(destDir, `${stem}-${Date.now()}${ext}`);
  }
  fs.copyFileSync(src, dest);
  return { path: dest, name: path.basename(dest), size: fs.statSync(dest).size };
});

ipcMain.handle("open-models-folder", async () => {
  const dir = userModelsDir();
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle("pick-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select texture",
    properties: ["openFile"],
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tga", "tif", "tiff", "exr", "dds"],
      },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("paste-image", async () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  const dir = path.join(app.getPath("temp"), "openmodeldb-upscaler");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `paste-${Date.now()}.png`);
  fs.writeFileSync(dest, img.toPNG());
  return dest;
});

ipcMain.handle("pick-save", async (_e, { defaultName, format }) => {
  const ext = (format || "png").toLowerCase();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export upscaled texture",
    defaultPath: defaultName || `texture_upscaled.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle("read-image-preview", async (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || "png";
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "bmp"
          ? "image/bmp"
          : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
});

ipcMain.handle("open-path", async (_e, target) => {
  if (!target) return;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    shell.showItemInFolder(target);
  } else {
    await shell.openPath(target);
  }
});

ipcMain.handle("open-external", async (_e, url) => {
  if (url) await shell.openExternal(url);
});

ipcMain.handle("omdb-list", async (_e, { query = "", scale = null, tag = "", limit = 60 } = {}) => {
  const data = await fetchOmdb(false);
  const q = String(query || "").trim().toLowerCase();
  const items = [];
  for (const [id, raw] of Object.entries(data)) {
    const m = summarizeModel(id, raw);
    if (!m.downloadUrl) continue;
    if (scale && Number(m.scale) !== Number(scale)) continue;
    if (tag && !(m.tags || []).map((t) => String(t).toLowerCase()).includes(String(tag).toLowerCase())) {
      continue;
    }
    if (q) {
      const hay = `${m.id} ${m.name} ${m.author} ${m.architecture} ${(m.tags || []).join(" ")} ${m.description}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    items.push(m);
  }
  items.sort((a, b) => {
    const score = (m) => {
      const reliablePair =
        m.lr &&
        m.sr &&
        /openmodeldb\.info|slow\.pics|imgsli\.com/i.test(`${m.lr} ${m.sr}`)
          ? 3
          : 0;
      const omdbThumb = m.thumbnail && /openmodeldb\.info\/thumbs/i.test(m.thumbnail) ? 2 : 0;
      const anyPreview = m.preview || m.thumbnail ? 1 : 0;
      return reliablePair || omdbThumb || anyPreview;
    };
    const d = score(b) - score(a);
    if (d) return d;
    return String(a.name).localeCompare(String(b.name));
  });
  return { total: items.length, models: items.slice(0, limit), base: OMDB_BASE };
});

ipcMain.handle("omdb-refresh", async () => {
  await fetchOmdb(true);
  return { ok: true, count: Object.keys(omdbCache || {}).length };
});

ipcMain.handle("download-model", async (event, opts) => {
  const {
    id,
    url,
    urls,
    filename,
    expectedSize,
    size,
    sha256,
  } = opts || {};
  const list = sortDownloadUrls([...(urls || []), url].filter(Boolean));
  if (!list.length) throw new Error("No download URL");

  return downloadModelFile({
    id,
    urls: list,
    filename,
    expectedSize: expectedSize || size || null,
    sha256: sha256 || null,
    onProgress: (received, total) => {
      event.sender.send("download-progress", {
        id,
        received,
        total,
        percent: total ? Math.round((received / total) * 100) : 0,
      });
    },
  });
});

ipcMain.handle("upscale", async (event, opts) => {
  if (activeJob) throw new Error("An upscale job is already running");
  const {
    input,
    output,
    modelPath,
    mode,
    factor,
    longest,
    format,
    tile,
  } = opts || {};

  if (!input || !fs.existsSync(input)) throw new Error("Input image missing");
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error("Model file missing");
  if (!output) throw new Error("Output path missing");

  const py = resolvePython();
  const script = pythonScript();
  if (!fs.existsSync(script)) throw new Error(`Upscale script missing: ${script}`);

  const args = [
    script,
    "--input",
    input,
    "--output",
    output,
    "--model",
    modelPath,
    "--mode",
    mode === "longest" ? "longest" : "factor",
    "--factor",
    String(factor || 4),
    "--longest",
    String(longest || 2048),
    "--format",
    String(format || "png"),
    "--tile",
    String(tile || 256),
    "--device",
    "auto",
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(py, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    activeJob = child;
    let stderr = "";
    let settled = false;
    let donePayload = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      activeJob = null;
      fn(value);
    };

    child.stdout.on("data", (buf) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("@@")) {
          try {
            const payload = JSON.parse(line.slice(2));
            event.sender.send("upscale-progress", payload);
            if (payload.type === "done") donePayload = payload;
            if (payload.type === "error") {
              settle(reject, new Error(payload.message || "Upscale failed"));
            }
          } catch {
            /* ignore parse errors */
          }
        } else {
          event.sender.send("upscale-log", line);
        }
      }
    });

    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
      event.sender.send("upscale-log", buf.toString("utf8"));
    });

    child.on("error", (err) => settle(reject, err));

    child.on("close", (code) => {
      if (code === 0) {
        settle(resolve, donePayload || { type: "done", output, code });
      } else {
        settle(reject, new Error(stderr.trim() || `Upscale process exited with code ${code}`));
      }
    });
  });
});

ipcMain.handle("cancel-upscale", async () => {
  if (activeJob) {
    activeJob.kill();
    activeJob = null;
    return true;
  }
  return false;
});

ipcMain.handle("python-status", async () => {
  const py = resolvePython();
  const exists = fs.existsSync(py) || py === "python" || py === "python3";
  return { python: py, ready: exists, script: pythonScript(), modelsDir: modelsDir(), userModelsDir: userModelsDir() };
});

#!/usr/bin/env node
/**
 * Create a local Python venv and install upscaling dependencies.
 * Prefers Pinokio miniforge / existing Python 3.10+, falls back to `py` launcher.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pythonDir = path.join(root, "python");
const venvDir = path.join(pythonDir, ".venv");
const reqFile = path.join(pythonDir, "requirements.txt");

const candidates = [
  process.env.PYTHON,
  process.env.UPSCALER_PYTHON,
].filter(Boolean);

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolvePython() {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  for (const cmd of ["python", "python3", "py"]) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return cmd;
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`> ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

function venvPython() {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

async function main() {
  const basePython = resolvePython();
  if (!basePython) {
    console.error("No Python 3 interpreter found. Install Python 3.10+ or set PYTHON=...");
    process.exit(1);
  }
  console.log(`Using Python: ${basePython}`);

  if (!exists(venvPython())) {
    await run(basePython, ["-m", "venv", venvDir]);
  }

  const py = venvPython();
  await run(py, ["-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"]);

  const torchArgs = [
    "-m",
    "pip",
    "install",
    "torch",
    "torchvision",
    "--index-url",
    "https://download.pytorch.org/whl/cu128",
  ];
  try {
    await run(py, torchArgs);
  } catch {
    console.warn("CUDA 12.8 torch install failed — trying default PyPI torch...");
    await run(py, ["-m", "pip", "install", "torch", "torchvision"]);
  }

  await run(py, ["-m", "pip", "install", "-r", reqFile]);
  console.log("\nPython environment ready at", venvDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

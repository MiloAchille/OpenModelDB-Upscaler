#!/usr/bin/env node
/**
 * Assemble a ready-to-run portable folder:
 *   dist/OpenModelDB-Upscaler-Portable/
 * containing the unpacked Electron app + models + python/.venv
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "OpenModelDB-Upscaler-Portable");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

console.log("Building unpacked Electron app…");
const build = spawnSync("npx", ["electron-builder", "--win", "--dir"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status || 1);

const unpacked = path.join(root, "dist", "win-unpacked");
if (!fs.existsSync(unpacked)) {
  console.error("Missing dist/win-unpacked");
  process.exit(1);
}

if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
console.log("Copying app →", outDir);
copyDir(unpacked, outDir);

const venv = path.join(root, "python", ".venv");
if (fs.existsSync(venv)) {
  console.log("Bundling python/.venv (large)…");
  copyDir(venv, path.join(outDir, "resources", "python", ".venv"));
} else {
  console.warn("No python/.venv found — run npm run setup first.");
}

console.log("\nPortable folder ready:");
console.log(" ", outDir);
console.log("Launch:", path.join(outDir, "OpenModelDB-Upscaler.exe"));

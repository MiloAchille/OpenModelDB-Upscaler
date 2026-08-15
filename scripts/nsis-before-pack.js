/**
 * electron-builder beforePack hook:
 * - show NSIS install details
 * - regenerate custom wizard bitmaps (#111117 + logo)
 */
const nsisShowDetails = require("./nsis-show-details.js").default;
const { spawnSync } = require("child_process");
const path = require("path");

exports.default = async function beforePack() {
  await nsisShowDetails();
  const gen = path.join(__dirname, "make-nsis-bitmaps.js");
  const r = spawnSync(process.execPath, [gen], { stdio: "inherit", windowsHide: true });
  if (r.status !== 0) {
    throw new Error("make-nsis-bitmaps.js failed");
  }
};

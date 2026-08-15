/**
 * electron-builder hides NSIS install details by default (SetDetailsPrint none).
 * Patch the template so Setup.exe shows file/extract progress in the details pane.
 */
const fs = require("fs");
const path = require("path");

async function nsisShowDetails() {
  const dest = path.join(
    __dirname,
    "..",
    "node_modules",
    "app-builder-lib",
    "templates",
    "nsis",
    "installSection.nsh"
  );
  if (!fs.existsSync(dest)) {
    console.warn("[nsis-show-details] installSection.nsh not found — skip");
    return;
  }
  let text = fs.readFileSync(dest, "utf8");
  if (!text.includes("SetDetailsPrint none")) {
    console.log("[nsis-show-details] already patched or missing SetDetailsPrint none");
    return;
  }
  text = text.replace(
    /\$\{IfNot\} \$\{Silent\}\r?\n\s*SetDetailsPrint none\r?\n\$\{endif\}/i,
    "${IfNot} ${Silent}\n  SetDetailsPrint both\n${endif}"
  );
  // Fallback if formatting differs
  if (text.includes("SetDetailsPrint none")) {
    text = text.replace("SetDetailsPrint none", "SetDetailsPrint both");
  }
  fs.writeFileSync(dest, text, "utf8");
  console.log("[nsis-show-details] enabled SetDetailsPrint both");
}

exports.default = nsisShowDetails;

if (require.main === module) {
  nsisShowDetails().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

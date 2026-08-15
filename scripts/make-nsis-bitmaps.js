/**
 * Generate NSIS wizard bitmaps: solid #111117 + centered app logo.
 * NSIS needs 24-bit BMP (not PNG).
 *   installerSidebar / uninstallerSidebar: 164 × 314
 *   installerHeader: 150 × 57
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOGO = path.join(ROOT, "assets", "logo.png");
const OUT_SIDE = path.join(ROOT, "assets", "installerSidebar.bmp");
const OUT_UNSIDE = path.join(ROOT, "assets", "uninstallerSidebar.bmp");
const OUT_HEADER = path.join(ROOT, "assets", "installerHeader.bmp");
const BG = "#111117";

function runPs(script) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "PowerShell failed").trim());
  }
}

function makeBmp(dest, width, height, logoMaxW, logoMaxH) {
  const logoEsc = LOGO.replace(/'/g, "''");
  const destEsc = dest.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Drawing
$w = ${width}; $h = ${height}
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('${BG}'))
$logo = [System.Drawing.Image]::FromFile('${logoEsc}')
$maxW = ${logoMaxW}; $maxH = ${logoMaxH}
$scale = [Math]::Min($maxW / $logo.Width, $maxH / $logo.Height)
$dw = [int]([Math]::Round($logo.Width * $scale))
$dh = [int]([Math]::Round($logo.Height * $scale))
$dx = [int](($w - $dw) / 2)
$dy = [int](($h - $dh) / 2)
$g.DrawImage($logo, $dx, $dy, $dw, $dh)
$logo.Dispose()
# Force 24-bit BMP (NSIS-friendly)
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$clone = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$bmp.Dispose(); $g.Dispose()
$clone.Save('${destEsc}', [System.Drawing.Imaging.ImageFormat]::Bmp)
$clone.Dispose()
Write-Output 'ok'
`;
  runPs(script);
  if (!fs.existsSync(dest)) throw new Error(`Failed to write ${dest}`);
  console.log(`wrote ${path.relative(ROOT, dest)} (${width}x${height})`);
}

if (!fs.existsSync(LOGO)) {
  console.error(`Missing logo: ${LOGO}`);
  process.exit(1);
}

makeBmp(OUT_SIDE, 164, 314, 120, 120);
fs.copyFileSync(OUT_SIDE, OUT_UNSIDE);
console.log(`wrote ${path.relative(ROOT, OUT_UNSIDE)} (copy)`);
makeBmp(OUT_HEADER, 150, 57, 120, 40);
console.log("NSIS bitmaps ready.");

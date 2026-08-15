# OpenModelDB Upscaler

> Vibecoded.

Desktop app for local AI texture upscaling, with browsing/download from [OpenModelDB](https://openmodeldb.info/).

Built with Electron + a Python Spandrel/PyTorch worker (CUDA when available).

## Features

- Local Spandrel inference (CUDA GPU or CPU)
- Size modes:
  - **Factor** — ×2 / ×3 / ×4 / ×6 / ×8 / ×16
  - **Longest side** — 512 → 16384 px
- Export: PNG, TGA, TIFF, DDS (uncompressed ARGB), EXR, WebP, JPEG, BMP
- Alpha preserved (RGB through the model, alpha resized)
- OpenModelDB catalog with previews + download (GitHub, Google Drive, MEGA, …)
- Local model library (import / manage weights)

## Requirements

- Windows x64 (primary target)
- [Node.js](https://nodejs.org/) 18+
- Python 3.10+ on `PATH` (or set `PYTHON=...`)
- NVIDIA GPU + CUDA-capable drivers recommended (CPU works, slower)

## Setup (developers)

```bash
git clone <your-repo-url>
cd Upscaler
npm install
npm run setup
```

`npm run setup` creates `python/.venv` and installs PyTorch + Spandrel.

### Default model weights

Model files are **not** stored in git (GitHub’s 100MB limit). Put a weight file in `models/`, for example:

- [4xLSDIRDAT](https://openmodeldb.info/models/4x-LSDIRDAT) → save as `models/4xLSDIRDAT.pth`

Or download any model from the in-app **OpenModelDB** tab / **Models → Import**.

Then:

```bash
npm start
```

## Build

```bash
build.bat
```

Or:

```bash
npm run dist
```

Produces clean artifacts in `dist/`:

- `OpenModelDB Upscaler-1.0.0-Setup.exe`
- `OpenModelDB Upscaler-1.0.0-Portable.exe`

The Electron packages include whatever is in `models/` at build time, plus the upscale script. The Python/CUDA venv is **not** embedded in those EXEs (too large). For a folder that also ships the venv:

```bash
npm run dist:full-portable
```

## Usage

1. Drop / paste / load a texture
2. Choose a model
3. Pick factor or longest-side size
4. Choose export format
5. Upscale

## Project layout

```
assets/                 # icons, logo
models/                 # local weights (gitignored binaries — see models/README.md)
python/upscale.py       # inference worker
python/requirements.txt
scripts/                # setup + portable pack helpers
src/main.js             # Electron main
src/preload.js
src/renderer/           # UI
build.bat               # Windows release build
```

## License

MIT — see [LICENSE](LICENSE).

Model weights you download keep their own licenses (often listed on OpenModelDB).

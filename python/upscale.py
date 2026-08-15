#!/usr/bin/env python3
"""Texture upscale worker — loads Spandrel models and writes game-dev formats."""
from __future__ import annotations

import argparse
import json
import struct
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message=".*meshgrid.*")
warnings.filterwarnings("ignore", category=UserWarning, module="torch")

import numpy as np
import torch
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader

# Allow very large texture targets (8K–16K); default PIL limit is ~89MP.
Image.MAX_IMAGE_PIXELS = None

try:
    import spandrel_extra_arches

    spandrel_extra_arches.install()
except Exception:
    pass


SUPPORTED_FORMATS = {"png", "tga", "tiff", "tif", "jpg", "jpeg", "webp", "bmp", "dds", "exr"}


def log(msg: str) -> None:
    print(msg, flush=True)


def progress(pct: float, stage: str = "") -> None:
    payload = {"type": "progress", "percent": round(max(0.0, min(100.0, pct)), 1), "stage": stage}
    print("@@" + json.dumps(payload), flush=True)


def load_rgba(path: Path) -> tuple[Image.Image, Image.Image | None]:
    img = Image.open(path)
    if img.mode in ("RGBA", "LA") or ("transparency" in img.info):
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        rgb = rgba.convert("RGB")
        return rgb, alpha
    return img.convert("RGB"), None


def image_to_tensor(img: Image.Image, device: torch.device) -> torch.Tensor:
    arr = np.asarray(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    return tensor.to(device)


def tensor_to_image(tensor: torch.Tensor) -> Image.Image:
    tensor = tensor.detach().float().clamp(0, 1).cpu()
    arr = (tensor.squeeze(0).permute(1, 2, 0).numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def upscale_tiled(
    model: ImageModelDescriptor,
    img: Image.Image,
    tile: int = 256,
    overlap: int = 16,
) -> Image.Image:
    device = model.device
    scale = int(model.scale)
    w, h = img.size
    if max(w, h) <= tile:
        with torch.inference_mode():
            out = model(image_to_tensor(img, device))
        return tensor_to_image(out)

    step = max(1, tile - overlap)
    out_w, out_h = w * scale, h * scale
    acc = np.zeros((out_h, out_w, 3), dtype=np.float32)
    weight = np.zeros((out_h, out_w, 1), dtype=np.float32)

    xs = list(range(0, max(1, w - overlap), step))
    ys = list(range(0, max(1, h - overlap), step))
    if xs[-1] + tile < w:
        xs.append(max(0, w - tile))
    if ys[-1] + tile < h:
        ys.append(max(0, h - tile))
    xs = sorted(set(xs))
    ys = sorted(set(ys))
    total = max(1, len(xs) * len(ys))
    done = 0

    with torch.inference_mode():
        for y0 in ys:
            for x0 in xs:
                x1 = min(x0 + tile, w)
                y1 = min(y0 + tile, h)
                x0c = max(0, x1 - tile)
                y0c = max(0, y1 - tile)
                tile_img = img.crop((x0c, y0c, x1, y1))
                out = model(image_to_tensor(tile_img, device))
                out_img = tensor_to_image(out)
                ox0, oy0 = x0c * scale, y0c * scale
                ox1, oy1 = x1 * scale, y1 * scale
                patch = np.asarray(out_img).astype(np.float32)
                acc[oy0:oy1, ox0:ox1] += patch
                weight[oy0:oy1, ox0:ox1] += 1.0
                done += 1
                progress(5 + 85 * done / total, f"tile {done}/{total}")

    weight = np.maximum(weight, 1.0)
    merged = (acc / weight).round().astype(np.uint8)
    return Image.fromarray(merged, mode="RGB")


def target_size_from_factor(w: int, h: int, factor: float) -> tuple[int, int]:
    return max(1, round(w * factor)), max(1, round(h * factor))


def target_size_from_longest(w: int, h: int, longest: int) -> tuple[int, int]:
    longest_side = max(w, h)
    if longest_side <= 0:
        return w, h
    scale = longest / longest_side
    return max(1, round(w * scale)), max(1, round(h * scale))


def resize_exact(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    if img.size == size:
        return img
    return img.resize(size, Image.Resampling.LANCZOS)


def reach_target(
    model: ImageModelDescriptor,
    rgb: Image.Image,
    target: tuple[int, int],
    tile: int,
) -> Image.Image:
    current = rgb
    model_scale = max(1, int(model.scale))
    tw, th = target
    # Repeated native upscales until both dims meet or exceed target, then downscale.
    guard = 0
    while (current.width < tw or current.height < th) and guard < 8:
        progress(8 + guard * 10, f"pass {guard + 1} ({model_scale}x)")
        current = upscale_tiled(model, current, tile=tile)
        guard += 1
        if guard >= 8:
            break
        # Stop early if a further pass would massively overshoot and we already exceed.
        if current.width >= tw and current.height >= th:
            break
    progress(92, "resizing to target")
    return resize_exact(current, target)


def write_uncompressed_dds(rgba: Image.Image, path: Path) -> None:
    """Write an uncompressed A8R8G8B8 DDS (game-dev friendly fallback)."""
    img = rgba.convert("RGBA")
    w, h = img.size
    pixels = img.tobytes("raw", "BGRA")
    # DDS header (128 bytes)
    header = bytearray(128)
    header[0:4] = b"DDS "
    struct.pack_into("<I", header, 4, 124)  # dwSize
    # DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT
    struct.pack_into("<I", header, 8, 0x1 | 0x2 | 0x4 | 0x8 | 0x1000)
    struct.pack_into("<I", header, 12, h)
    struct.pack_into("<I", header, 16, w)
    struct.pack_into("<I", header, 20, w * 4)  # pitch
    struct.pack_into("<I", header, 76, 32)  # pf size
    struct.pack_into("<I", header, 80, 0x41)  # DDPF_RGB | DDPF_ALPHAPIXELS
    struct.pack_into("<I", header, 88, 32)  # RGB bit count
    struct.pack_into("<I", header, 92, 0x00FF0000)  # R
    struct.pack_into("<I", header, 96, 0x0000FF00)  # G
    struct.pack_into("<I", header, 100, 0x000000FF)  # B
    struct.pack_into("<I", header, 104, 0xFF000000)  # A
    struct.pack_into("<I", header, 108, 0x1000)  # DDSCAPS_TEXTURE
    path.write_bytes(bytes(header) + pixels)


def save_image(rgb: Image.Image, alpha: Image.Image | None, path: Path, fmt: str) -> None:
    fmt = fmt.lower().lstrip(".")
    if fmt in ("jpg", "jpeg"):
        rgb.convert("RGB").save(path, format="JPEG", quality=95, optimize=True)
        return
    if fmt == "webp":
        out = Image.merge("RGBA", (*rgb.split(), alpha)) if alpha else rgb
        out.save(path, format="WEBP", quality=95, method=6)
        return
    if fmt == "bmp":
        rgb.convert("RGB").save(path, format="BMP")
        return
    if fmt in ("tif", "tiff"):
        out = Image.merge("RGBA", (*rgb.split(), alpha)) if alpha else rgb
        out.save(path, format="TIFF", compression="tiff_deflate")
        return
    if fmt == "tga":
        out = Image.merge("RGBA", (*rgb.split(), alpha)) if alpha else rgb.convert("RGBA")
        out.save(path, format="TGA")
        return
    if fmt == "dds":
        out = Image.merge("RGBA", (*rgb.split(), alpha)) if alpha else rgb.convert("RGBA")
        write_uncompressed_dds(out, path)
        return
    if fmt == "exr":
        try:
            import cv2  # type: ignore
        except ImportError as exc:
            raise RuntimeError("EXR export requires opencv-python-headless") from exc
        arr = np.asarray(rgb.convert("RGB")).astype(np.float32) / 255.0
        bgr = arr[:, :, ::-1]
        if not cv2.imwrite(str(path), bgr):
            raise RuntimeError("Failed to write EXR")
        return
    # png default
    out = Image.merge("RGBA", (*rgb.split(), alpha)) if alpha else rgb
    out.save(path, format="PNG", optimize=True)


def resolve_device(prefer: str) -> torch.device:
    if prefer == "cpu":
        return torch.device("cpu")
    if prefer == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if prefer == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device("cpu")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--mode", choices=["factor", "longest"], required=True)
    parser.add_argument("--factor", type=float, default=4.0)
    parser.add_argument("--longest", type=int, default=2048)
    parser.add_argument("--format", default="png")
    parser.add_argument("--tile", type=int, default=256)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    fmt = args.format.lower().lstrip(".")
    if fmt not in SUPPORTED_FORMATS:
        raise SystemExit(f"Unsupported format: {fmt}")

    in_path = Path(args.input)
    out_path = Path(args.output)
    model_path = Path(args.model)
    if not in_path.exists():
        raise SystemExit(f"Input not found: {in_path}")
    if not model_path.exists():
        raise SystemExit(f"Model not found: {model_path}")

    progress(1, "loading image")
    rgb, alpha = load_rgba(in_path)
    w, h = rgb.size
    if args.mode == "factor":
        target = target_size_from_factor(w, h, args.factor)
    else:
        target = target_size_from_longest(w, h, args.longest)

    log(f"Input {w}x{h} -> target {target[0]}x{target[1]} via {model_path.name}")

    progress(3, "loading model")
    device = resolve_device(args.device)
    if device.type == "cuda":
        gpu_name = torch.cuda.get_device_name(0)
        log(f"Device: CUDA GPU — {gpu_name}")
    else:
        log("Device: CPU — no CUDA GPU detected (slower, still works)")
    descriptor = ModelLoader().load_from_file(str(model_path))
    if not isinstance(descriptor, ImageModelDescriptor):
        raise SystemExit("Loaded model is not an image model")
    model = descriptor.to(device).eval()
    if device.type == "cuda":
        try:
            model = model.half()
        except Exception:
            pass

    progress(5, "upscaling")
    out_rgb = reach_target(model, rgb, target, tile=max(64, args.tile))
    out_alpha = resize_exact(alpha, target) if alpha is not None else None

    progress(96, "saving")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    save_image(out_rgb, out_alpha, out_path, fmt)
    progress(100, "done")
    result = {
        "type": "done",
        "output": str(out_path),
        "width": out_rgb.width,
        "height": out_rgb.height,
        "format": fmt,
    }
    print("@@" + json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        err = {"type": "error", "message": str(exc)}
        print("@@" + json.dumps(err), flush=True)
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)

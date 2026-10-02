"""Build the assets for the 2D front-view rose from public/img/1.png.

    uv run make2d.py [--src path.png] [--engine ultrasharp|realesrgan|swin2sr] [--skip-sr]

1. read the source. A transparent PNG keeps its own alpha (steps 1 and 3 are
   skipped for it); an opaque picture is cleaned (a black band at the bottom
   becomes backdrop) and its backdrop level is measured from the borders
2. super-resolve ×4 (4x-UltraSharp by default, via spandrel), then restore
   the photo's exact tones by correcting only the low frequencies
3. opaque pictures only: cut the rose out (solid alpha inside the object,
   colour-to-alpha for the glows and sparkle rays around it); a transparent
   PNG has its alpha upscaled with the same model instead
4. effect maps: gold mask (R), depth (G), petal mask (B) for the WebGL page
5. sparkle anchors on the gold clusters and existing glints

Outputs go to public/rose2d/.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, Swin2SRForImageSuperResolution, pipeline

import metrics as M

SRC = M.IMG_DIR / "1.png"
DEST = M.ROOT.parent.parent / "public" / "rose2d"
SR_MODEL = "caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr"
WEIGHTS = M.ROOT / "weights"
# GAN upscalers loaded with spandrel; weights downloaded into tools/rose-fit/weights
SPANDREL_MODELS = {"realesrgan": "RealESRGAN_x4plus.pth", "ultrasharp": "4x-UltraSharp.pth"}
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
BG = 30  # replaced by the measured backdrop level in main()
# longest side of the published picture: ×4 upscale, then area-downsampled
# (sharper than a native ×2) and kept under common 4096px texture limits
MAX_SIDE = 2560
# backdrop used to analyse a transparent PNG (matches the page default)
CUTOUT_BACKDROP = 29
MAX_GOLD_SPARKLES = 60
MAX_GLINT_SPARKLES = 24


def device() -> str:
    return "mps" if torch.backends.mps.is_available() else "cpu"


def estimate_background(img: np.ndarray) -> int:
    border = np.concatenate([img[:8].reshape(-1, 3), img[-8:].reshape(-1, 3), img[:, :8].reshape(-1, 3), img[:, -8:].reshape(-1, 3)])
    return int(np.median(border))


def clean(img: np.ndarray) -> np.ndarray:
    out = img.copy()
    h, w = out.shape[:2]
    # black band left by the screenshot: rows whose borders are pure black
    band = next((y for y in range(h) if out[y, :8].max() < 8 and out[y, -8:].max() < 8), h)
    near_black = out[band:].max(axis=2) < 14
    out[band:][near_black] = BG
    return out


def _tiled(rgb: np.ndarray, scale: int, out_scale: float, run, tile: int = 128, pad: int = 16) -> np.ndarray:
    """Run `run(patch_rgb_uint8) -> float RGB [0,1] at ×scale` over overlapping tiles.

    Each tile is area-resampled to `out_scale` right away, so a large source can
    use a ×4 model for its sharpness without ever holding a ×4 canvas.
    """
    h, w = rgb.shape[:2]
    f = out_scale
    H, W = round(h * f), round(w * f)
    out = np.zeros((H, W, 3), np.float32)
    weight = np.zeros((H, W, 1), np.float32)
    rows = (h + tile - 1) // tile
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            ys, xs = max(0, y - pad), max(0, x - pad)
            ye, xe = min(h, y + tile + pad), min(w, x + tile + pad)
            sr = run(rgb[ys:ye, xs:xe])[: (ye - ys) * scale, : (xe - xs) * scale]
            Y0, X0, Y1, X1 = round(ys * f), round(xs * f), round(ye * f), round(xe * f)
            if f != scale:
                interp = cv2.INTER_AREA if f < scale else cv2.INTER_CUBIC
                sr = cv2.resize(sr, (X1 - X0, Y1 - Y0), interpolation=interp)
            # feathered window so tile seams blend away
            wy = np.minimum(np.arange(sr.shape[0]) + 1, sr.shape[0] - np.arange(sr.shape[0])).astype(np.float32)
            wx = np.minimum(np.arange(sr.shape[1]) + 1, sr.shape[1] - np.arange(sr.shape[1])).astype(np.float32)
            win = np.minimum(np.minimum.outer(wy, wx), max(1.0, pad * f))[..., None]
            out[Y0:Y1, X0:X1] += sr * win
            weight[Y0:Y1, X0:X1] += win
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()  # large sources otherwise pile up GPU memory
        print(f"  super-res row {y // tile + 1}/{rows}", flush=True)
    return out / np.maximum(weight, 1e-6)


def output_scale(shape: tuple[int, ...]) -> float:
    """×4 at most, and no longer side than MAX_SIDE."""
    return min(4.0, MAX_SIDE / max(shape[:2]))


def super_resolve(img: np.ndarray, engine: str = "swin2sr", out_scale: float | None = None) -> np.ndarray:
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    if engine == "swin2sr":
        proc = AutoImageProcessor.from_pretrained(SR_MODEL)
        model = Swin2SRForImageSuperResolution.from_pretrained(SR_MODEL).to(device()).eval()

        def run(patch):
            inputs = proc(Image.fromarray(patch), return_tensors="pt").to(device())
            with torch.no_grad():
                return model(**inputs).reconstruction[0].clamp(0, 1).permute(1, 2, 0).cpu().numpy()

        scale = model.config.upscale
    else:
        from spandrel import ModelLoader

        desc = ModelLoader().load_from_file(str(WEIGHTS / SPANDREL_MODELS[engine]))
        model = desc.model.to(device()).eval()
        scale = desc.scale

        def run(patch):
            t = torch.from_numpy(patch).permute(2, 0, 1)[None].float().div(255).to(device())
            with torch.no_grad():
                return model(t)[0].clamp(0, 1).permute(1, 2, 0).cpu().numpy()

    out = _tiled(rgb, scale, out_scale or scale, run)
    return cv2.cvtColor((out * 255).round().astype(np.uint8), cv2.COLOR_RGB2BGR)


def tone_match(sr: np.ndarray, base: np.ndarray, sigma: float = 1.5) -> np.ndarray:
    """Give the upscale the photo's exact colours and shading.

    GAN upscalers drift in tone; correcting only the low frequencies (blurred
    difference to the original) restores them without bringing back the
    JPEG softness that a full back-projection would re-inject at the edges.
    """
    h, w = base.shape[:2]
    b = cv2.GaussianBlur(base.astype(np.float32), (0, 0), sigma)
    d = cv2.GaussianBlur(cv2.resize(sr.astype(np.float32), (w, h), interpolation=cv2.INTER_AREA), (0, 0), sigma)
    corr = cv2.resize(b - d, (sr.shape[1], sr.shape[0]), interpolation=cv2.INTER_CUBIC)
    return np.clip(sr.astype(np.float32) + corr, 0, 255).round().astype(np.uint8)


def object_mask(img: np.ndarray) -> np.ndarray:
    """Solid mask of the rose, leaves and stem (no glows)."""
    diff = np.abs(img.astype(np.int16) - BG).max(axis=2)
    m = (diff > 22).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] > m.size * 0.002
    m = keep[lab].astype(np.uint8)
    # fill enclosed holes (dark folds inside the bloom). Pad first: the rose may
    # touch the top and bottom edges and split the backdrop into separate parts
    flood = np.pad(m, 1)
    cv2.floodFill(flood, np.zeros((flood.shape[0] + 2, flood.shape[1] + 2), np.uint8), (0, 0), 1)
    return (m | (1 - flood[1:-1, 1:-1])).astype(np.uint8)


def cut_out(img: np.ndarray, solid: np.ndarray) -> np.ndarray:
    """RGBA: solid inside the object, colour-to-alpha against BG elsewhere."""
    c = img.astype(np.float32) / 255
    b = BG / 255
    # only light can be "added" over the backdrop (glows, rays); darker pixels
    # are the vignette of the photo and must stay transparent
    a_ch = np.where(c > b, (c - b) / (1 - b), 0)
    alpha = a_ch.max(axis=2)
    soft = cv2.GaussianBlur(solid.astype(np.float32), (0, 0), 1.2)
    # JPEG noise on the backdrop would leave faint ghosts; glows are brighter
    alpha = np.where(alpha < 0.07, 0, (alpha - 0.07) / 0.93)
    alpha = np.maximum(alpha, np.clip(soft * 1.5, 0, 1))
    alpha = np.clip(alpha, 0, 1)
    fg = np.where(alpha[..., None] > 1e-3, (c - b) / np.maximum(alpha[..., None], 1e-3) + b, 0)
    fg = np.where(soft[..., None] > 0.5, c, np.clip(fg, 0, 1))  # keep exact colours inside
    rgba = np.dstack([fg, alpha])
    return (rgba * 255).round().astype(np.uint8)


def sparkle_anchors(img: np.ndarray, cls: np.ndarray) -> list[dict]:
    """Largest gold clusters and brightest glints, capped so the page stays calm."""
    h, w = cls.shape
    anchors = []
    gold = (cls == M.CLASS_GOLD).astype(np.uint8)
    n, _, stats, cent = cv2.connectedComponentsWithStats(gold)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area >= 6:
            anchors.append({"x": cent[i][0] / w, "y": cent[i][1] / h, "size": float(min(1.0, 0.35 + area / 400)), "kind": "gold", "_area": int(area)})
    L = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)[..., 0]
    glint = ((L > 248) & (cv2.GaussianBlur(L, (0, 0), 3) > 200)).astype(np.uint8)
    n, _, stats, cent = cv2.connectedComponentsWithStats(glint)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 3:
            anchors.append({"x": cent[i][0] / w, "y": cent[i][1] / h, "size": 1.0, "kind": "glint", "_area": int(stats[i, cv2.CC_STAT_AREA])})
    pick = lambda kind, n: sorted((a for a in anchors if a["kind"] == kind), key=lambda a: -a["_area"])[:n]
    chosen = pick("gold", MAX_GOLD_SPARKLES) + pick("glint", MAX_GLINT_SPARKLES)
    for a in chosen:
        del a["_area"]
    return chosen


def read_source(path: Path) -> tuple[np.ndarray, np.ndarray | None]:
    """BGR picture, plus its alpha (0..1) when the PNG is already cut out."""
    raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise FileNotFoundError(path)
    if raw.dtype == np.uint16:
        raw = (raw / 257).round().astype(np.uint8)
    if raw.ndim == 2:
        raw = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    if raw.shape[2] == 4:
        a = raw[..., 3]
        # a real cut-out has a sizeable fully transparent area; a few
        # near-opaque pixels (like the 249..255 alpha of 1.png) do not count
        if (a < 10).mean() > 0.02:
            return raw[..., :3].copy(), a.astype(np.float32) / 255
    return raw[..., :3].copy(), None


def checker_matte(img: np.ndarray) -> np.ndarray | None:
    """Alpha for a picture whose "transparency" is a painted checkerboard.

    AI tools often export the grey checkerboard as real pixels. Detect it on
    the border (grey, two clearly separated tones), flood the grey pixels in
    that tone range inward from the edges, and return a feathered mask of
    what is left (the subject). None when there is no checkerboard.
    """
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.int16)
    L, a, b = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    gray = (np.abs(a) <= 4) & (np.abs(b) <= 4)
    edge = np.zeros(L.shape, bool)
    edge[:, :60] = edge[:, -60:] = edge[:40] = edge[-40:] = True
    if gray[edge].mean() < 0.9:
        return None
    vals = L[edge & gray].astype(np.float32).reshape(-1, 1)
    _, lbl, cent = cv2.kmeans(vals, 2, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 3, cv2.KMEANS_PP_CENTERS)
    share = np.bincount(lbl.ravel(), minlength=2) / len(lbl)
    if abs(float(cent[0, 0] - cent[1, 0])) < 15 or share.min() < 0.25:
        return None
    lo, hi = np.percentile(L[edge], 1) - 6, np.percentile(L[edge], 99.5) + 8
    cand = cv2.morphologyEx((gray & (L >= lo) & (L <= hi)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    _, cc = cv2.connectedComponents(cand, connectivity=4)
    border_ids = np.unique(np.concatenate([cc[0], cc[-1], cc[:, 0], cc[:, -1]]))
    bg = np.isin(cc, border_ids[border_ids > 0]).astype(np.uint8)
    # cells are split by thin, lighter grid lines: close them into one backdrop
    bg = cv2.morphologyEx(bg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    obj = cv2.morphologyEx(1 - bg, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, cc, st, _ = cv2.connectedComponentsWithStats(obj)
    keep = np.zeros(n, bool)
    keep[1:] = st[1:, cv2.CC_STAT_AREA] > obj.size * 0.002
    obj = keep[cc].astype(np.uint8)
    flood = np.pad(obj, 1)
    cv2.floodFill(flood, np.zeros((flood.shape[0] + 2, flood.shape[1] + 2), np.uint8), (0, 0), 1)
    obj |= 1 - flood[1:-1, 1:-1]
    # step one pixel inside so the anti-aliased checker grey does not fringe the edge
    obj = cv2.erode(obj, np.ones((3, 3), np.uint8))
    return np.clip(cv2.GaussianBlur(obj.astype(np.float32), (0, 0), 0.8), 0, 1)


def fill_transparent(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Spread the edge colours into fully transparent pixels.

    Their RGB is undefined (often black); left as is, the upscaler would pull
    it into the rose's edges as a dark fringe.
    """
    img = bgr.astype(np.float32)
    hole = alpha < 0.02
    out = img.copy()
    todo = hole.copy()
    w0 = alpha.copy()
    for sigma in (1, 2, 4, 8, 16, 32, 64):
        w = cv2.GaussianBlur(w0, (0, 0), sigma)
        c = cv2.GaussianBlur(img * w0[..., None], (0, 0), sigma) / np.maximum(w, 1e-6)[..., None]
        take = todo & (w > 1e-3)
        out[take] = c[take]
        todo &= ~take
    return np.clip(out, 0, 255).round().astype(np.uint8)


def upscale_alpha(alpha: np.ndarray, engine: str, size: tuple[int, int], out_scale: float) -> np.ndarray:
    """Run the upscaler on the alpha too, so the cut-out edge is as crisp as the picture."""
    g = (alpha * 255).round().astype(np.uint8)
    g3 = cv2.merge([g, g, g])
    sr = tone_match(super_resolve(g3, engine, out_scale), g3).astype(np.float32).mean(axis=2)
    sr = cv2.resize(sr, size, interpolation=cv2.INTER_AREA)
    return np.clip(sr / 255, 0, 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-sr", action="store_true", help="reuse out/2d/sr.png")
    ap.add_argument("--engine", default="ultrasharp", choices=["ultrasharp", "realesrgan", "swin2sr"])
    ap.add_argument("--src", help=f"source picture (default {SRC.relative_to(M.ROOT.parent.parent)})")
    args = ap.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    work = M.OUT / "2d"
    work.mkdir(parents=True, exist_ok=True)

    global BG
    src_path = Path(args.src) if args.src else SRC
    src, alpha = read_source(src_path)
    kind = "transparent PNG"
    if alpha is None:
        alpha = checker_matte(src)
        kind = "painted checkerboard backdrop (fake transparency)"
    cutout = alpha is not None
    if cutout:
        # already cut out: keep its alpha (glass stays see-through), analyse
        # the picture composited over the default page backdrop
        BG = CUTOUT_BACKDROP
        print(f"  source {src.shape[1]}x{src.shape[0]}, {kind} ({(alpha < 0.02).mean():.0%} empty)")
        base = (src.astype(np.float32) * alpha[..., None] + BG * (1 - alpha[..., None])).round().astype(np.uint8)
        sr_input = fill_transparent(src, alpha)
    else:
        BG = estimate_background(src)
        print(f"  source {src.shape[1]}x{src.shape[0]}, opaque, backdrop level {BG}")
        base = clean(src)
        sr_input = base
    cv2.imwrite(str(work / "clean.png"), base)

    if args.skip_sr and (work / "sr.png").exists():
        sr = cv2.imread(str(work / "sr.png"))
    else:
        sr = tone_match(super_resolve(sr_input, args.engine, output_scale(sr_input.shape)), sr_input)
        cv2.imwrite(str(work / "sr.png"), sr)
    H, W = sr.shape[:2]
    scale = W / base.shape[1]
    print(f"  {base.shape[1]}x{base.shape[0]} -> {W}x{H}")

    if cutout:
        a_path = work / "sr_alpha.png"
        if args.skip_sr and a_path.exists():
            a_sr = cv2.imread(str(a_path), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255
        else:
            a_sr = upscale_alpha(alpha, args.engine, (W, H), output_scale(alpha.shape))
            cv2.imwrite(str(a_path), (a_sr * 255).round().astype(np.uint8))
        a8 = (a_sr * 255).round().astype(np.uint8)
        sr = sr.copy()
        sr[a8 == 0] = 0  # invisible pixels: no colour, so the WebP stays small
        rgba = np.dstack([sr, a8])
        solid_lo = (alpha > 0.3).astype(np.uint8)
    else:
        # cut-out at full resolution, mask from the upscaled low-res mask (stabler edges)
        solid_lo = object_mask(base)
        solid = (cv2.resize(solid_lo.astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR) > 0.5).astype(np.uint8)
        solid &= (np.abs(sr.astype(np.int16) - BG).max(axis=2) > 10).astype(np.uint8) | cv2.erode(solid, np.ones((9, 9), np.uint8))
        rgba = cut_out(sr, solid)
    Image.fromarray(cv2.cvtColor(rgba, cv2.COLOR_BGRA2RGBA)).save(DEST / "rose.webp", quality=92, method=6)

    # effect maps (half the display resolution is plenty)
    fw, fh = W // 2, H // 2
    cls = M.segment(base)
    gold = (cls == M.CLASS_GOLD).astype(np.float32)
    gold = cv2.GaussianBlur(cv2.resize(gold, (fw, fh), interpolation=cv2.INTER_LINEAR), (0, 0), 1.5)
    gold = np.clip(gold * 1.6, 0, 1)
    bloom = M.find_head(cls).mask
    petal = cv2.GaussianBlur(cv2.resize(((cls == M.CLASS_PETAL) & bloom).astype(np.float32), (fw, fh)), (0, 0), 2)
    est = pipeline("depth-estimation", model=DEPTH_MODEL, device=device())
    depth = np.array(est(Image.fromarray(cv2.cvtColor(base, cv2.COLOR_BGR2RGB)))["depth"]).astype(np.float32)
    depth = cv2.resize(depth, (base.shape[1], base.shape[0]))
    m = solid_lo.astype(bool)
    lo, hi = np.percentile(depth[m], [2, 98])
    depth = np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1) * m
    depth = cv2.GaussianBlur(cv2.resize(depth, (fw, fh)), (0, 0), 4)
    fx = np.dstack([gold, depth, petal])
    Image.fromarray((fx * 255).round().astype(np.uint8)).save(DEST / "fx.png", optimize=True)

    anchors = sparkle_anchors(base, cls)
    for a in anchors:  # depth at each anchor, so sparkles follow the parallax
        a["depth"] = float(depth[min(fh - 1, int(a["y"] * fh)), min(fw - 1, int(a["x"] * fw))])
    meta = {"width": W, "height": H, "scale": scale, "sparkles": anchors}
    if not cutout:
        # an opaque picture carries its backdrop inside the glass; the page
        # uses the same colour so the cut-out is seamless
        meta["background"] = "#%02x%02x%02x" % (BG, BG, BG)
    (DEST / "rose.json").write_text(json.dumps(meta, indent=1))
    kb = lambda p: (DEST / p).stat().st_size // 1024
    print(f"  wrote rose.webp ({kb('rose.webp')} KB), fx.png ({kb('fx.png')} KB), {len(anchors)} sparkle anchors")


if __name__ == "__main__":
    main()

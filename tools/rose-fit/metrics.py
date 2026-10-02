"""Shared measurement code: segmentation, features and render-vs-reference scores.

All colours are OpenCV 8-bit LAB (L 0..255, a/b offset by 128). The reference
photos were screenshotted from a code editor, so the background is #1e1e1e
and some frames carry code text that must be ignored.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from skimage.color import deltaE_ciede2000
from skimage.metrics import structural_similarity

ROOT = Path(__file__).resolve().parent
IMG_DIR = ROOT.parent.parent / "public" / "img"
OUT = ROOT / "out"

# Code-text overlays in the screenshots, as (x0, y0, x1, y1) boxes.
IGNORE_BOXES: dict[str, list[tuple[int, int, int, int]]] = {
    "1": [(0, 0, 95, 16)],  # was img-3942
    "img-3943": [(0, 0, 150, 22)],
    "img-3944": [],
    "img-3945": [(0, 400, 50, 462)],
    "img-3946": [(0, 0, 35, 55)],
    "img-3947": [(0, 205, 240, 248), (0, 312, 14, 342)],
    "img-3948": [(0, 478, 210, 507)],
    "img-3949": [(0, 255, 80, 312)],
}

CLASS_BG, CLASS_PETAL, CLASS_GOLD, CLASS_FOLIAGE = 0, 1, 2, 3
CLASS_NAMES = {CLASS_PETAL: "petal", CLASS_GOLD: "gold", CLASS_FOLIAGE: "foliage"}
CLASS_COLORS = {  # BGR, for overlays
    CLASS_BG: (0, 0, 0),
    CLASS_PETAL: (180, 120, 255),
    CLASS_GOLD: (0, 215, 255),
    CLASS_FOLIAGE: (90, 170, 90),
}


def reference_names() -> list[str]:
    return sorted(p.stem for p in IMG_DIR.glob("*.jpeg"))


def load_reference(name: str) -> np.ndarray:
    img = cv2.imread(str(IMG_DIR / f"{name}.jpeg"))
    if img is None:
        raise FileNotFoundError(name)
    return img


def ignore_mask(name: str, shape: tuple[int, ...]) -> np.ndarray:
    """True where pixels must not be scored (code text, the editor's top border)."""
    m = np.zeros(shape[:2], bool)
    m[:5, :] = True
    for x0, y0, x1, y1 in IGNORE_BOXES.get(name, []):
        m[y0:y1, x0:x1] = True
    return m


def segment(bgr: np.ndarray) -> np.ndarray:
    """Per-pixel class: background, pink petal, gold, foliage (leaf/sepal/stem)."""
    lab = cv2.cvtColor(cv2.GaussianBlur(bgr, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.int16)
    L, a, b = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    fg = L > 52
    pink = fg & (a >= 9) & (a > b + 4)
    yellowish = fg & (b >= 9) & (b > a + 2) & (L >= 150)

    # Gold hugs the petals; khaki leaves of the same hue sit away from them.
    near_petal = cv2.dilate(pink.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    gold = yellowish & near_petal
    # Darker, crusty gold reads olive like the leaves; tell them apart by size:
    # gilding comes in small islands on the petals, sepals and leaves are big.
    olive = fg & ~pink & (b > a) & (L >= 95) & near_petal
    n, lab_cc, stats, _ = cv2.connectedComponentsWithStats(olive.astype(np.uint8), connectivity=8)
    small = np.zeros(n, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < 500
    gold |= small[lab_cc] & olive
    # Specular glints inside the gilding are near-white; keep them as gold.
    glint = fg & (L > 235) & cv2.dilate(gold.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)

    cls = np.full(bgr.shape[:2], CLASS_BG, np.uint8)
    cls[fg] = CLASS_FOLIAGE
    cls[pink] = CLASS_PETAL
    # Very light, low-chroma pixels inside the bloom are petal highlights.
    pale = fg & (L > 215) & (np.abs(a) < 12) & (np.abs(b) < 12) & near_petal
    cls[pale] = CLASS_PETAL
    cls[gold | glint] = CLASS_GOLD
    # Drop isolated foliage speckle (JPEG noise on the dark background).
    m = (cls == CLASS_FOLIAGE).astype(np.uint8)
    opened = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cls[(m == 1) & (opened == 0)] = CLASS_BG
    return cls


@dataclass
class Head:
    """The flower head: bounding box and centroid of petal+gold pixels."""

    cx: float
    cy: float
    x0: int
    y0: int
    x1: int
    y1: int
    mask: np.ndarray


def find_head(cls: np.ndarray) -> Head:
    m = ((cls == CLASS_PETAL) | (cls == CLASS_GOLD)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        h, w = cls.shape
        return Head(w / 2, h / 3, 0, 0, w, h, m.astype(bool))
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = stats[i, :4]
    mask = lab == i
    ys, xs = np.nonzero(mask)
    return Head(float(xs.mean()), float(ys.mean()), int(x), int(y), int(x + w), int(y + h), mask)


def lab_float(bgr: np.ndarray) -> np.ndarray:
    """True CIELAB (L 0..100) for ΔE computations."""
    return cv2.cvtColor(bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)


def highpass_luma(bgr: np.ndarray, sigma: float = 4.0) -> np.ndarray:
    L = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)
    return L - cv2.GaussianBlur(L, (0, 0), sigma)


def vein_stats(bgr: np.ndarray, region: np.ndarray, center: tuple[float, float]) -> dict:
    """Fine-streak statistics inside `region`.

    contrast: std of the high-passed lightness (how strong the veins read)
    wavelength: Gabor wavelength (px) with the most energy
    radial: share of that energy aligned with the direction to the flower
            centre (veins fan out from the petal bases toward the margins)
    """
    # Measure only the smooth inside of petals: drop margins and folds,
    # which would otherwise dominate the high-pass energy.
    folds = cv2.dilate(edge_map(bgr, region).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    region = cv2.erode(region.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool) & ~folds
    if region.sum() < 200:
        return {"contrast": 0.0, "wavelength": 0.0, "radial": 0.0, "energy": {}}
    hp = highpass_luma(bgr)
    energy: dict[str, float] = {}
    best, best_lam = -1.0, 0.0
    thetas = np.linspace(0, np.pi, 8, endpoint=False)
    resp_by_theta = {}
    for lam in (3, 4, 6, 8, 12):
        total = 0.0
        for th in thetas:
            k = cv2.getGaborKernel((0, 0), sigma=lam * 0.56, theta=th, lambd=lam, gamma=0.5, psi=0)
            k -= k.mean()
            k /= np.abs(k).sum()
            r = np.abs(cv2.filter2D(hp, cv2.CV_32F, k))
            total += float(r[region].mean())
            if lam == 6:
                resp_by_theta[th] = r
        energy[str(lam)] = total / len(thetas)
        if energy[str(lam)] > best:
            best, best_lam = energy[str(lam)], lam

    # Radial alignment: Gabor theta is the normal of the stripes; a radial
    # vein has its normal perpendicular to the direction to the centre.
    h, w = region.shape
    yy, xx = np.mgrid[0:h, 0:w]
    ang = np.arctan2(yy - center[1], xx - center[0])
    radial_e, all_e = 0.0, 0.0
    for th, r in resp_by_theta.items():
        align = np.abs(np.cos((th - ang) - np.pi / 2))  # 1 when stripe runs radially
        radial_e += float((r * align)[region].sum())
        all_e += float(r[region].sum())
    return {
        "contrast": float(hp[region].std()),
        "wavelength": float(best_lam),
        "radial": radial_e / max(all_e, 1e-6),
        "energy": energy,
    }


def edge_map(bgr: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Petal outlines and folds inside the bloom."""
    L = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)[..., 0]
    L = cv2.bilateralFilter(L, 7, 30, 5)
    e = cv2.Canny(L, 35, 90) > 0
    return e & cv2.erode(region.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)


def radial_profile(values: np.ndarray, mask: np.ndarray, center: tuple[float, float], rmax: float, bins: int = 12):
    h, w = mask.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - center[0], yy - center[1]) / max(rmax, 1)
    out = []
    for i in range(bins):
        sel = mask & (r >= i / bins) & (r < (i + 1) / bins)
        out.append(float(values[sel].mean()) if sel.sum() > 20 else None)
    return out


def features(bgr: np.ndarray, ignore: np.ndarray | None = None) -> dict:
    """Everything we measure on one image (reference or render)."""
    if ignore is None:
        ignore = np.zeros(bgr.shape[:2], bool)
    cls = segment(bgr)
    cls[ignore] = CLASS_BG
    head = find_head(cls)
    lab8 = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    labf = lab_float(bgr)
    petal = (cls == CLASS_PETAL) & ~ignore
    gold = (cls == CLASS_GOLD) & ~ignore
    foliage = (cls == CLASS_FOLIAGE) & ~ignore
    bloom = petal | gold
    rmax = max(head.x1 - head.x0, head.y1 - head.y0) / 2

    def mean_lab(m):
        return [float(v) for v in labf[m].mean(0)] if m.sum() > 20 else None

    hist = np.histogram(lab8[..., 0][petal], bins=16, range=(0, 256))[0].astype(float)
    hist /= max(hist.sum(), 1)
    edges = edge_map(bgr, head.mask)
    gold_dist = None
    if gold.sum() > 20:
        outside = (~bloom).astype(np.uint8)
        dist = cv2.distanceTransform(1 - outside, cv2.DIST_L2, 3)
        gold_dist = float(np.median(dist[gold]))
    n_gold, _, gstats, _ = cv2.connectedComponentsWithStats(gold.astype(np.uint8))
    return {
        "size": [int(bgr.shape[1]), int(bgr.shape[0])],
        "head": {
            "cx": head.cx, "cy": head.cy,
            "bbox": [head.x0, head.y0, head.x1, head.y1],
            "area": int(head.mask.sum()),
        },
        "share": {
            "petal": float(petal.mean()),
            "gold": float(gold.mean()),
            "foliage": float(foliage.mean()),
            "gold_of_bloom": float(gold.sum() / max(bloom.sum(), 1)),
        },
        "color": {"petal": mean_lab(petal), "gold": mean_lab(gold), "foliage": mean_lab(foliage)},
        "petal_lightness": {
            "hist16": hist.tolist(),
            "p10_50_90": [float(v) for v in np.percentile(lab8[..., 0][petal], [10, 50, 90])] if petal.sum() else None,
            "radial": radial_profile(lab8[..., 0].astype(float), petal, (head.cx, head.cy), rmax),
        },
        "edges": {
            "density": float(edges.sum() / max(head.mask.sum(), 1)),
            "radial": radial_profile(edges.astype(float), head.mask, (head.cx, head.cy), rmax),
        },
        "veins": vein_stats(bgr, petal, (head.cx, head.cy)),
        "gold": {
            "median_dist_to_edge_px": gold_dist,
            "clusters": int(n_gold - 1),
            "mean_cluster_px": float(gstats[1:, cv2.CC_STAT_AREA].mean()) if n_gold > 1 else 0.0,
        },
        "_cls": cls,
        "_edges": edges,
        "_head": head,
    }


def public(feat: dict) -> dict:
    return {k: v for k, v in feat.items() if not k.startswith("_")}


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def chamfer(a: np.ndarray, b: np.ndarray) -> float:
    """Symmetric mean distance (px) between two edge maps."""
    if a.sum() == 0 or b.sum() == 0:
        return 50.0
    da = cv2.distanceTransform((~a).astype(np.uint8), cv2.DIST_L2, 3)
    db = cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, 3)
    return float((db[a].mean() + da[b].mean()) / 2)


def compare(ref_bgr: np.ndarray, ref_feat: dict, ren_bgr: np.ndarray, ignore: np.ndarray) -> dict:
    """Scores of one render against one reference (same size)."""
    ren_feat = features(ren_bgr, ignore)
    rc, nc = ref_feat["_cls"], ren_feat["_cls"]
    valid = ~ignore
    sil = iou((rc > 0) & valid, (nc > 0) & valid)
    parts = {name: iou((rc == c) & valid, (nc == c) & valid) for c, name in CLASS_NAMES.items()}

    de = {}
    for k in ("petal", "foliage", "gold"):
        a, b = ref_feat["color"][k], ren_feat["color"][k]
        de[k] = float(deltaE_ciede2000(np.array([a]), np.array([b]))[0]) if a and b else 30.0

    h1 = np.array(ref_feat["petal_lightness"]["hist16"])
    h2 = np.array(ren_feat["petal_lightness"]["hist16"])
    hist_dist = float(0.5 * np.abs(h1 - h2).sum())

    # SSIM of the bloom crop in grey.
    x0, y0, x1, y1 = ref_feat["head"]["bbox"]
    g1 = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]
    g2 = cv2.cvtColor(ren_bgr, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]
    ssim = float(structural_similarity(g1, g2, data_range=255)) if min(g1.shape) >= 7 else 0.0

    # Petal outline layout inside the inner 60% of the bloom (the bud).
    hd = ref_feat["_head"]
    h, w = rc.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - hd.cx, yy - hd.cy) / max((hd.x1 - hd.x0) / 2, 1)
    core = r < 0.6
    cham = chamfer(ref_feat["_edges"] & core, ren_feat["_edges"] & core)

    v1, v2 = ref_feat["veins"], ren_feat["veins"]
    vein_err = abs(v1["contrast"] - v2["contrast"]) / max(v1["contrast"], 1e-3)

    return {
        "silhouette_iou": sil,
        "part_iou": parts,
        "deltaE": de,
        "lightness_hist_dist": hist_dist,
        "ssim": ssim,
        "core_chamfer_px": cham,
        "vein_contrast_err": vein_err,
        "_render_feat": ren_feat,
    }


def overlay(bgr: np.ndarray, cls: np.ndarray, alpha: float = 0.45) -> np.ndarray:
    col = np.zeros_like(bgr)
    for c, color in CLASS_COLORS.items():
        col[cls == c] = color
    return cv2.addWeighted(bgr, 1 - alpha, col, alpha, 0)


def dump_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

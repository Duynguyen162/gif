"""Measure the eight reference photos and write numbers + annotated images.

    uv run analyze.py            -> out/analysis.json, out/analysis/<name>_*.png
"""

from __future__ import annotations

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import pipeline

from metrics import OUT, dump_json, features, ignore_mask, load_reference, overlay, public, radial_profile, reference_names, highpass_luma

DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"


def depth_estimator():
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    return pipeline("depth-estimation", model=DEPTH_MODEL, device=device)


def depth_stats(depth: np.ndarray, head_mask: np.ndarray, center, rmax) -> dict:
    """Relative depth inside the bloom (0 = farthest, 1 = nearest)."""
    d = depth.astype(np.float32)
    vals = d[head_mask]
    lo, hi = np.percentile(vals, [2, 98])
    dn = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)
    gy, gx = np.gradient(cv2.GaussianBlur(dn, (0, 0), 2))
    slope = np.hypot(gx, gy)
    lap = cv2.Laplacian(cv2.GaussianBlur(dn, (0, 0), 3), cv2.CV_32F)
    return {
        "radial_depth": radial_profile(dn, head_mask, center, rmax),
        "radial_slope": radial_profile(slope, head_mask, center, rmax),
        # positive mean laplacian = locally concave (cupped) surfaces dominate
        "radial_concavity": radial_profile(-lap, head_mask, center, rmax),
        "_norm": dn,
    }


def colorize(x: np.ndarray, cmap=cv2.COLORMAP_INFERNO) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return cv2.applyColorMap((x * 255).astype(np.uint8), cmap)


def main() -> None:
    est = depth_estimator()
    report = {}
    sheet_rows = []
    out_dir = OUT / "analysis"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in reference_names():
        bgr = load_reference(name)
        ign = ignore_mask(name, bgr.shape)
        feat = features(bgr, ign)
        head = feat["_head"]
        rmax = max(head.x1 - head.x0, head.y1 - head.y0) / 2

        depth = np.array(est(Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))["depth"]).astype(np.float32)
        depth = cv2.resize(depth, (bgr.shape[1], bgr.shape[0]))
        dstats = depth_stats(depth, head.mask, (head.cx, head.cy), rmax)
        dn = dstats.pop("_norm")

        report[name] = {**public(feat), "depth": dstats}

        seg = overlay(bgr, feat["_cls"])
        cv2.circle(seg, (int(head.cx), int(head.cy)), 4, (255, 255, 255), -1)
        cv2.rectangle(seg, (head.x0, head.y0), (head.x1, head.y1), (255, 255, 255), 1)
        edges = bgr.copy()
        edges[feat["_edges"]] = (0, 255, 255)
        hp = highpass_luma(bgr)
        veins = cv2.cvtColor(np.clip(hp * 6 + 128, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        dep = colorize(dn * head.mask)
        for img, tag in ((seg, "seg"), (edges, "edges"), (veins, "veins"), (dep, "depth")):
            cv2.imwrite(str(out_dir / f"{name}_{tag}.png"), img)
        row = np.hstack([bgr, seg, edges, veins, dep])
        sheet_rows.append(cv2.resize(row, (row.shape[1] * 360 // row.shape[0], 360)))
        print(f"{name}: petal {feat['share']['petal']:.3f} gold {feat['share']['gold']:.4f} "
              f"veins c={feat['veins']['contrast']:.2f} λ={feat['veins']['wavelength']} radial={feat['veins']['radial']:.2f}")

    width = max(r.shape[1] for r in sheet_rows)
    sheet = np.vstack([np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in sheet_rows])
    cv2.imwrite(str(OUT / "analysis_sheet.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    dump_json(OUT / "analysis.json", report)
    print("wrote", OUT / "analysis.json")


if __name__ == "__main__":
    main()

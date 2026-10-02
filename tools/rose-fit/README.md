# rose-fit

Builds the 2D rose shown on `/` from the reference picture `public/img/1.png`,
and measures the result against it. Everything runs locally; only model
weights are downloaded.

## Setup

```sh
brew install uv
cd tools/rose-fit
uv sync --python 3.12
mkdir -p weights
curl -L -o weights/4x-UltraSharp.pth https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth
# optional alternative upscaler
curl -L -o weights/RealESRGAN_x4plus.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
```

## Build the assets

```sh
uv run make2d.py                    # 4x-UltraSharp (default)
uv run make2d.py --engine swin2sr   # smoother, Hugging Face Swin2SR
uv run make2d.py --skip-sr          # reuse out/2d/sr.png, rebuild the rest
```

Writes `public/rose2d/`:

| file | content |
|---|---|
| `rose.webp` | the rose upscaled ×4 then fitted to 2560 px, background removed (solid inside, soft alpha for glows) |
| `fx.png` | R gold mask, G depth (Depth Anything V2), B petal mask |
| `rose.json` | size and sparkle anchors (gold clusters and glints, with depth) |

Upscaling: GAN upscalers drift in tone, so `tone_match` corrects only the low
frequencies back to the photo. A full back-projection scores better on paper
but re-injects the JPEG softness as double edges.

Measured on the flower (photo vs page with `?still=1`, scaled back to the
photo size): SSIM 0.970, mean ΔE2000 1.38.

## Analyse the photos

```sh
uv run analyze.py   # out/analysis.json + out/analysis_sheet.jpg
```

Per photo: class shares, LAB colours, petal lightness, petal outlines, vein
Gabor spectrum, gold distribution and depth profiles (`metrics.py`).

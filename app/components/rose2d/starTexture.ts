import * as THREE from "three";

/** Four-point star with a soft halo, drawn once into a canvas. */
export function createStarTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;

  const halo = ctx.createRadialGradient(c, c, 0, c, c, c);
  halo.addColorStop(0, "rgba(255,255,255,1)");
  halo.addColorStop(0.05, "rgba(255,246,220,0.85)");
  halo.addColorStop(0.16, "rgba(255,226,160,0.12)");
  halo.addColorStop(1, "rgba(255,210,130,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  const ray = (angle: number, len: number, thick: number) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0, "rgba(255,240,200,0)");
    g.addColorStop(0.5, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -thick, len, 0);
    ctx.quadraticCurveTo(0, thick, -len, 0);
    ctx.fill();
    ctx.restore();
  };
  ray(0, c, 3.2);
  ray(Math.PI / 2, c, 3.2);
  ray(Math.PI / 4, c * 0.45, 1.6);
  ray(-Math.PI / 4, c * 0.45, 1.6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

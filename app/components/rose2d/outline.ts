/** Outline helpers for the paper and ribbon shapes (plain math, no three.js). */

export type Pt = [number, number];

export function quad(a: Pt, c: Pt, b: Pt, n = 16): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const k = 1 - t;
    return [k * k * a[0] + 2 * k * t * c[0] + t * t * b[0], k * k * a[1] + 2 * k * t * c[1] + t * t * b[1]];
  });
}

/** a->b, bowed out to its left by `bow`, with `waves` soft scallops */
export function ruffle(a: Pt, b: Pt, waves: number, amp: number, bow = 0, n = 48): Pt[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const o = bow * 4 * t * (1 - t) + amp * Math.abs(Math.sin(t * Math.PI * waves));
    return [a[0] + dx * t + nx * o, a[1] + dy * t + ny * o];
  });
}

export const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, y]);

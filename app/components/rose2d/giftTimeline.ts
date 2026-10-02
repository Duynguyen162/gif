/**
 * The gift reveal, as a pure function of time (no three.js, so it can be
 * checked outside the browser). Units are rose heights with the origin at the
 * neck of the parcel, y up — the same frame as BouquetScene.
 *
 *   idle        parcel bobs, light breathes inside, dust circles it
 *   0.0 – 0.6   shake: eager wobble, squash and stretch
 *   0.5 – 1.5   untie: tails slip and fall, loops spin away, knot pops
 *   1.3 – 3.0   unwrap: five sheets open like petals, staggered
 *   2.4 – 3.4   burst: rays, a ring of light, stars thrown out
 *   2.8 – 4.8   bloom: the rose appears from its heart out, rim of gold
 *   4.0 – 6.5   glitter rain; the sheets settle into a collar
 *   6.5 →       live: the usual tilt, sweep and sparkles
 */
import { mirror, type Pt, quad, ruffle } from "./outline";

export const END = 6.5;

/** rose size in the finished picture */
export const ROSE_S = 1.05;
/** where the burst and the bloom start: the heart of the rose, in picture uv (v from the top) */
export const HEART = { u: 0.53, v: 0.33 };

/** one cellophane sheet, growing out of the neck */
export const PETAL: Pt[] = [
  ...quad([0, -0.02], [-0.34, 0.34], [-0.16, 0.74]),
  ...ruffle([-0.16, 0.74], [0.16, 0.74], 3, 0.02, 0.1).slice(1),
  ...quad([0.16, 0.74], [0.34, 0.34], [0, -0.02]).slice(1, -1),
];

/** the gold band left on the neck once the bow is off */
export const BAND: Pt[] = [
  ...quad([-0.085, 0.012], [0, 0.03], [0.085, 0.012]),
  ...quad([0.085, -0.022], [0, -0.004], [-0.085, -0.022]),
];

/** the gathered paper below the neck */
export const SLEEVE: Pt[] = [
  [-0.07, -0.02],
  ...quad([0.07, -0.02], [0.08, -0.18], [0.15, -0.32]),
  ...ruffle([0.15, -0.32], [-0.15, -0.32], 4, 0.02).slice(1),
  ...quad([-0.15, -0.32], [-0.08, -0.18], [-0.07, -0.02]).slice(1, -1),
];
export { mirror };

type Fold = "back" | "side" | "down";
type PetalSpec = { closed: number; open: number; s: number; openS: number; start: number; fold: Fold; alpha: [number, number] };

/** back sheets first (drawn behind the rose), then the front ones */
export const PETALS: PetalSpec[] = [
  // back: fan out behind the head
  { closed: 0.34, open: 0.74, s: 1.12, openS: 1.26, start: 1.75, fold: "back", alpha: [0.5, 0.36] },
  { closed: -0.34, open: -0.74, s: 1.12, openS: 1.26, start: 1.85, fold: "back", alpha: [0.5, 0.36] },
  // front sides: swing out and bend toward the viewer into a collar
  { closed: 0.17, open: 1.2, s: 1.06, openS: 1.06, start: 1.45, fold: "side", alpha: [0.72, 0.58] },
  { closed: -0.17, open: -1.2, s: 1.06, openS: 1.06, start: 1.55, fold: "side", alpha: [0.72, 0.58] },
  // front centre: flops down over the neck
  { closed: 0, open: 0, s: 1.02, openS: 1.02, start: 1.3, fold: "down", alpha: [0.74, 0.5] },
];
export const BACK_PETALS = 2;

export type Xform = { x: number; y: number; rot: number; sx: number; sy: number };
export type PetalPose = Xform & { shade: number; alpha: number };
export type PiecePose = Xform & { alpha: number };
export type Pose = {
  /** the whole parcel: bob, shake, squash */
  parcel: Xform;
  petals: PetalPose[];
  /** TAIL_L, TAIL_R, LOOP_L, LOOP_R, KNOT */
  bow: PiecePose[];
  /** `lift` slides the rose up its stem, out of the wrap */
  rose: { reveal: number; s: number; rot: number; lift: number; flash: number };
  light: { glow: number; rays: number; ring: number; ringAlpha: number };
};

// --- easing ----------------------------------------------------------------

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
/** 0 → 1 across [start, start + dur] */
export const seg = (t: number, start: number, dur: number) => clamp01((t - start) / dur);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;
const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOutBack = (k: number, o = 1.7) => 1 + (o + 1) * (k - 1) ** 3 + o * (k - 1) ** 2;
const bump = (k: number) => Math.sin(Math.PI * clamp01(k));

const still: Xform = { x: 0, y: 0, rot: 0, sx: 1, sy: 1 };

/** a bow piece: an optional wind-up, then thrown off along a falling arc */
function thrown(t: number, release: number, v: Pt, spin: number, windRot: number, windS: number, windStart: number): Xform {
  const w = seg(t, windStart, release - windStart);
  const dt = Math.max(t - release, 0);
  return {
    x: v[0] * dt,
    y: v[1] * dt - 0.9 * dt * dt,
    rot: windRot * w + spin * dt,
    sx: 1 - windS * w,
    sy: 1 - windS * w,
  };
}

/**
 * @param t seconds since the parcel was opened, or null while it waits
 * @param time seconds since the scene started (idle motion)
 * @param reduced the viewer asked for less motion
 */
export function pose(t: number | null, time: number, reduced = false): Pose {
  const idle = t === null;
  const k = idle ? -1 : t;
  // the idle motion fades out as the show starts
  const calm = idle ? 1 : 1 - seg(k, 0, 0.4);

  const shake = reduced ? 0 : 0.07 * Math.sin(k * 38) * (1 - seg(k, 0, 0.6)) * (k > 0 ? 1 : 0);
  const squash = reduced ? 0 : bump(seg(k, 0.25, 0.35));
  const parcel: Xform = {
    x: 0,
    y: 0.012 * Math.sin(time * 1.6) * calm,
    rot: shake + 0.012 * Math.sin(time * 1.1) * calm,
    sx: 1 + 0.05 * squash,
    sy: 1 - 0.06 * squash,
  };

  const petals = PETALS.map((p, i): PetalPose => {
    const lin = seg(k, p.start, reduced ? 0.6 : 1.1);
    const e = easeOutBack(lin);
    const breathe = 0.012 * Math.sin(time * 1.6 + i) * calm;
    const s = lerp(p.s, p.openS, e);
    const pose: PetalPose = {
      ...still,
      rot: lerp(p.closed, p.open, e) + breathe,
      sx: s,
      sy: s,
      shade: 1,
      alpha: lerp(p.alpha[0], p.alpha[1], lin),
    };
    if (p.fold === "side") {
      // turns edge-on halfway, showing its duskier back, then bends forward
      pose.sx *= 1 - 0.5 * bump(lin);
      pose.sy = s * lerp(1, 0.42, e);
      pose.shade = 1 - 0.25 * bump(lin) - 0.08 * e;
    } else if (p.fold === "down") {
      // folds down toward the viewer and hangs below the neck
      pose.sy = s * lerp(1, -0.32, e);
      pose.shade = pose.sy < 0 ? 0.82 : 1 - 0.2 * bump(lin);
    }
    return pose;
  });

  const sway = 0.04 * Math.sin(time * 2) * calm;
  const fadeTails = 1 - seg(k, 1.0, 0.6);
  const fadeLoops = 1 - seg(k, 1.05, 0.55);
  const tailSlip = 0.04 * seg(k, 0.5, 0.35);
  const tailL = thrown(k, 0.85, [-0.25, 0.1], 2.5, 0, 0, 0.5);
  const tailR = thrown(k, 0.85, [0.25, 0.12], -2.8, 0, 0, 0.5);
  const loopL = thrown(k, 0.9, [-0.38, 0.6], 5, 0.35, 0.15, 0.5);
  const loopR = thrown(k, 0.9, [0.38, 0.62], -5, -0.35, 0.15, 0.5);
  const knotS = (1 + 0.3 * bump(seg(k, 0.85, 0.3))) * (1 - seg(k, 1.0, 0.18));
  const bow: PiecePose[] = [
    { ...tailL, y: tailL.y - tailSlip, rot: tailL.rot - sway * 0.5, alpha: fadeTails },
    { ...tailR, y: tailR.y - tailSlip, rot: tailR.rot + sway * 0.5, alpha: fadeTails },
    { ...loopL, rot: loopL.rot + sway, alpha: fadeLoops },
    { ...loopR, rot: loopR.rot - sway, alpha: fadeLoops },
    { ...still, sx: knotS, sy: knotS, alpha: knotS > 0.001 ? 1 : 0 },
  ];

  const settle = seg(k, 3.2, 1.6);
  const rose = {
    reveal: easeInOutCubic(seg(k, 2.8, 1.6)) * 1.1,
    s: ROSE_S * lerp(0.85, 1, easeOutBack(seg(k, 2.8, 1.2))),
    rot: reduced ? 0 : 0.07 * Math.sin(settle * Math.PI * 3) * (1 - settle),
    lift: lerp(-0.04, 0.12, easeOutCubic(seg(k, 2.8, 1.8))),
    flash: Math.exp(-(((k - 3.7) / 0.35) ** 2)),
  };

  const breathing = 0.22 + 0.08 * Math.sin(time * 2.2);
  const light = {
    glow: idle
      ? breathing
      : (breathing + 0.3 * seg(k, 0, 0.6) + 0.6 * seg(k, 1.3, 1.3)) * (1 - 0.8 * seg(k, 3.2, 1.2)),
    rays: reduced ? 0 : 0.6 * seg(k, 2.4, 0.3) * (1 - easeInOutCubic(seg(k, 2.9, 1.0))),
    ring: easeOutCubic(seg(k, 2.5, 0.9)) * 1.3,
    ringAlpha: reduced || k < 2.5 ? 0 : 0.45 * (1 - seg(k, 2.5, 0.9)),
  };

  return { parcel, petals, bow, rose, light };
}

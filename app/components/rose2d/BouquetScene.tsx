"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  ASSETS,
  BACKDROP,
  type Meta,
  PARALLAX,
  roseFragment,
  roseVertex,
  SHARPEN,
  sparkleFragment,
  sparkleVertex,
  type Textures,
  useMouse,
  useRoseTextures,
} from "./Rose2DScene";
import { mirror, type Pt, quad, ruffle } from "./outline";
import { createStarTexture } from "./starTexture";

// Everything here is laid out in "rose heights": 1 = the height of the rose
// picture at full size. The origin is the tie point where the stems meet,
// y points up.

/** where the stem crosses the binding, in picture uv (v from the top) */
export const TIE = { u: 0.552, v: 0.72 };

/**
 * One rose of the bunch. It turns about the tie point, then slides `lift`
 * along its own stem; `shade` darkens the roses deeper in the bunch.
 */
type Placement = { rot: number; lift: number; s: number; shade: number; flip?: boolean };

/** back to front: each row covers the stems of the one behind */
const ROSES: Placement[] = [
  // back row, smaller and in shadow
  { s: 0.56, rot: 0.66, lift: 0.2, shade: 0.68 },
  { s: 0.55, rot: -0.64, lift: 0.22, shade: 0.68, flip: true },
  { s: 0.56, rot: 0.22, lift: 0.38, shade: 0.72, flip: true },
  { s: 0.55, rot: -0.2, lift: 0.36, shade: 0.72 },
  // middle row
  { s: 0.62, rot: 0.44, lift: 0.06, shade: 0.84 },
  { s: 0.62, rot: -0.42, lift: 0.07, shade: 0.84, flip: true },
  { s: 0.62, rot: 0.02, lift: 0.22, shade: 0.86 },
  // front, in full light
  { s: 0.7, rot: 0.2, lift: -0.05, shade: 1, flip: true },
  { s: 0.68, rot: -0.2, lift: -0.07, shade: 1 },
];

/** how far a layer slides with the tilt, on top of each rose's own parallax */
const LAYER_SHIFT = 0.012;

// --- outlines --------------------------------------------------------------

/** cellophane behind the heads, flaring out of the binding */
const BACK_SHEET: Pt[] = [[-0.1, -0.02], ...ruffle([-0.62, 0.46], [0.62, 0.46], 7, 0.03, 0.3), [0.1, -0.02]];
/** the two front sheets, folded across each other below the heads */
const LEFT_SHEET: Pt[] = [...quad([-0.07, -0.04], [-0.42, 0.12], [-0.64, 0.44]), ...ruffle([-0.64, 0.44], [0.1, 0.06], 4, 0.02, -0.06).slice(1)];
const RIGHT_SHEET: Pt[] = mirror([
  ...quad([-0.07, -0.04], [-0.42, 0.12], [-0.62, 0.4]),
  ...ruffle([-0.62, 0.4], [0.12, 0.02], 4, 0.02, -0.06).slice(1),
]);
/** the gathered paper around the stems under the tie */
const SLEEVE: Pt[] = [
  [-0.07, -0.02],
  ...quad([0.07, -0.02], [0.09, -0.26], [0.18, -0.46]),
  ...ruffle([0.18, -0.46], [-0.18, -0.46], 5, 0.02).slice(1),
  ...quad([-0.18, -0.46], [-0.09, -0.26], [-0.07, -0.02]).slice(1, -1),
];

// the bow, tied over the binding
export const LOOP_R: Pt[] = [...quad([0, 0], [0.1, 0.13], [0.2, 0.04]), ...quad([0.2, 0.04], [0.14, -0.06], [0, 0]).slice(1, -1)];
export const LOOP_L: Pt[] = mirror([...quad([0, 0], [0.09, 0.12], [0.18, 0.05]), ...quad([0.18, 0.05], [0.13, -0.05], [0, 0]).slice(1, -1)]);
export const TAIL_R: Pt[] = [
  ...quad([0.0, -0.01], [0.05, -0.1], [0.12, -0.26]),
  [0.09, -0.235],
  [0.075, -0.275],
  ...quad([0.075, -0.275], [0.03, -0.12], [-0.02, -0.02]).slice(1),
];
export const TAIL_L: Pt[] = mirror([
  ...quad([0.0, -0.01], [0.03, -0.1], [0.08, -0.24]),
  [0.05, -0.22],
  [0.035, -0.255],
  ...quad([0.035, -0.255], [0.01, -0.12], [-0.02, -0.02]).slice(1),
]);
export const KNOT: Pt[] = Array.from({ length: 24 }, (_, i) => {
  const a = (i / 24) * Math.PI * 2;
  return [Math.cos(a) * 0.04, Math.sin(a) * 0.034 - 0.005];
});

// --- shaders ---------------------------------------------------------------

/** the rose shader, dimmed by `uShade` for roses deeper in the bunch */
const shadedRoseFragment = roseFragment
  .replace("uniform vec2 uRes;", "uniform vec2 uRes;\nuniform float uShade;")
  .replace("gl_FragColor = c;", "c.rgb *= uShade;\n  gl_FragColor = c;");
const shadedSparkleFragment = sparkleFragment
  .replace("varying float vAlpha;", "varying float vAlpha;\nuniform float uShade;")
  .replace("t.a * vAlpha", "t.a * vAlpha * uShade");

export const flatVertex = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** pearly cellophane: creases fanning out of the tie, a drifting rainbow sheen */
export const paperFragment = /* glsl */ `
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uTint;
uniform float uAlpha;
uniform float uShade;
uniform float uSeed;
varying vec2 vPos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  float r = length(vPos);
  float ang = atan(vPos.x, vPos.y);
  // creases run outward from the binding, wobbling a little
  float wob = noise(vec2(ang * 6.0 + uSeed, r * 4.0)) * 2.0;
  float crease = sin(ang * 46.0 + wob * 3.0 + uSeed);
  float fold = smoothstep(0.55, 1.0, crease) - 0.6 * smoothstep(0.4, 1.0, -crease);
  vec3 c = uTint * (0.9 + 0.12 * fold);
  // gathered paper is thicker and duskier near the tie
  c *= mix(0.72, 1.0, smoothstep(0.0, 0.35, r));
  // oil-slick sheen sliding across with the tilt
  float h = ang * 1.4 + r * 3.0 + uMouse.x * 1.2 - uMouse.y * 0.8 + uTime * 0.12;
  c += 0.06 * (0.5 + 0.5 * cos(6.2832 * (h + vec3(0.0, 0.33, 0.67))));
  float phase = (vPos.x * 0.9 + vPos.y * 1.3) * 5.0 - uTime * 1.1 - uMouse.x * 3.0 + uMouse.y * 2.0;
  c += pow(max(sin(phase), 0.0), 12.0) * 0.12 * max(fold, 0.0);
  float a = uAlpha * (0.85 + 0.25 * max(fold, 0.0));
  gl_FragColor = vec4(c * uShade, a);
  #include <colorspace_fragment>
}`;

/** satin and gilt: soft bands across the ribbon and the same sweeping light as the roses */
export const satinFragment = /* glsl */ `
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uLight;
uniform vec3 uDark;
uniform vec2 uGrain;
varying vec2 vPos;
void main() {
  float band = 0.5 + 0.5 * sin(dot(vPos, uGrain) * 60.0 + uMouse.x * 2.0);
  vec3 c = mix(uDark, uLight, smoothstep(0.1, 0.9, band));
  float phase = (vPos.x * 0.9 + vPos.y * 1.3) * 7.0 - uTime * 1.1 - uMouse.x * 3.0 + uMouse.y * 2.0;
  c += pow(max(sin(phase), 0.0), 10.0) * 0.35 * vec3(1.0, 0.9, 0.65);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// --- pieces ----------------------------------------------------------------

/** a band of `width` along a polyline, for the gilt edges */
export function strokeGeometry(pts: Pt[], width: number, closed: boolean) {
  const n = pts.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const next = pts[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * width * 0.5;
    const ny = (dx / len) * width * 0.5;
    pos.push(pts[i][0] + nx, pts[i][1] + ny, 0, pts[i][0] - nx, pts[i][1] - ny, 0);
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export function shapeGeometry(pts: Pt[]) {
  return new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
}

export type Clock = { time: number; mouse: THREE.Vector2 };

/** keeps a material's time and tilt in step with the bunch */
function useAnimated(clock: RefObject<Clock>) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u) return;
    u.uTime.value = clock.current.time;
    u.uMouse.value.copy(clock.current.mouse);
  });
  return mat;
}

/** slides a whole layer with the tilt, more for the layers nearer the viewer */
export function useLayerShift(depth: number, clock: RefObject<Clock>) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const m = clock.current.mouse;
    ref.current?.position.set(-m.x * (depth - 0.5) * LAYER_SHIFT, -m.y * (depth - 0.5) * LAYER_SHIFT, 0);
  });
  return ref;
}

function GiltEdge({ pts, order, closed = true, width = 0.0045 }: { pts: Pt[]; order: number; closed?: boolean; width?: number }) {
  const geo = useMemo(() => strokeGeometry(pts, width, closed), [pts, width, closed]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} renderOrder={order}>
      <meshBasicMaterial color="#e2bd78" transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Paper({
  pts,
  tint,
  alpha,
  shade = 1,
  seed,
  depth,
  order,
  clock,
}: {
  pts: Pt[];
  tint: string;
  alpha: number;
  shade?: number;
  seed: number;
  depth: number;
  order: number;
  clock: RefObject<Clock>;
}) {
  const geo = useMemo(() => shapeGeometry(pts), [pts]);
  useEffect(() => () => geo.dispose(), [geo]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uTint: { value: new THREE.Color(tint) },
      uAlpha: { value: alpha },
      uShade: { value: shade },
      uSeed: { value: seed },
    }),
    [tint, alpha, shade, seed],
  );
  const mat = useAnimated(clock);
  const layer = useLayerShift(depth, clock);
  return (
    <group ref={layer}>
      <mesh geometry={geo} renderOrder={order}>
        <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={flatVertex} fragmentShader={paperFragment} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <GiltEdge pts={pts} order={order + 0.5} />
    </group>
  );
}

function Satin({ pts, grain, order, clock }: { pts: Pt[]; grain: Pt; order: number; clock: RefObject<Clock> }) {
  const geo = useMemo(() => shapeGeometry(pts), [pts]);
  useEffect(() => () => geo.dispose(), [geo]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uLight: { value: new THREE.Color("#f3dca6") },
      uDark: { value: new THREE.Color("#a8783a") },
      uGrain: { value: new THREE.Vector2(...grain) },
    }),
    [grain],
  );
  const mat = useAnimated(clock);
  return (
    <>
      <mesh geometry={geo} renderOrder={order}>
        <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={flatVertex} fragmentShader={satinFragment} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <GiltEdge pts={pts} order={order + 0.5} width={0.003} />
    </>
  );
}

function Bow({ order, clock }: { order: number; clock: RefObject<Clock> }) {
  const layer = useLayerShift(1, clock);
  return (
    <group ref={layer}>
      <Satin pts={TAIL_L} grain={[0.4, 0.15]} order={order} clock={clock} />
      <Satin pts={TAIL_R} grain={[-0.4, 0.15]} order={order + 1} clock={clock} />
      <Satin pts={LOOP_L} grain={[0.2, 0.5]} order={order + 2} clock={clock} />
      <Satin pts={LOOP_R} grain={[-0.2, 0.5]} order={order + 3} clock={clock} />
      <Satin pts={KNOT} grain={[0, 0.6]} order={order + 4} clock={clock} />
    </group>
  );
}

type RoseProps = {
  meta: Meta;
  still: boolean;
  place: Placement;
  /** screen pixels per rose height */
  unit: number;
  order: number;
  depth: number;
  starTex: THREE.Texture;
  clock: RefObject<Clock>;
} & Textures;

function BouquetRose({ meta, still, rose, fx, place, unit, order, depth, starTex, clock }: RoseProps) {
  const dpr = useThree((s) => s.viewport.dpr);
  const roseMat = useRef<THREE.ShaderMaterial>(null);
  const sparkleMat = useRef<THREE.ShaderMaterial>(null);
  const layer = useLayerShift(depth, clock);

  const aspect = meta.width / meta.height;
  const { s } = place;

  const roseUniforms = useMemo(
    () => ({
      uRose: { value: rose },
      uFx: { value: fx },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uParallax: { value: PARALLAX },
      uFxOn: { value: still ? 0 : 1 },
      uRes: { value: new THREE.Vector2(meta.width, meta.height) },
      uTexel: { value: new THREE.Vector2() },
      uSharpen: { value: SHARPEN },
      uShade: { value: place.shade },
    }),
    [rose, fx, still, meta.width, meta.height, place.shade],
  );

  const sparkles = useMemo(() => {
    const n = meta.sparkles.length;
    const pos = new Float32Array(n * 3);
    const sz = new Float32Array(n);
    const phase = new Float32Array(n);
    const sp = new Float32Array(n);
    const dp = new Float32Array(n);
    const glints = new Float32Array(n);
    meta.sparkles.forEach((p, i) => {
      pos.set([p.x - 0.5, 0.5 - p.y, 0.01], i * 3);
      const glint = p.kind === "glint" ? 1 : 0;
      sz[i] = (glint ? 0.072 : 0.024 + 0.039 * p.size) * meta.width;
      // offset per rose so the bunch doesn't twinkle in unison
      phase[i] = (i * 2.399 + order * 1.7) % (Math.PI * 2);
      sp[i] = 0.9 + ((i * 0.618) % 1) * 1.8;
      dp[i] = p.depth;
      glints[i] = glint;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aSpeed", new THREE.BufferAttribute(sp, 1));
    g.setAttribute("aDepth", new THREE.BufferAttribute(dp, 1));
    g.setAttribute("aGlint", new THREE.BufferAttribute(glints, 1));
    return g;
  }, [meta, order]);
  useEffect(() => () => sparkles.dispose(), [sparkles]);

  const sparkleUniforms = useMemo(
    () => ({
      uTex: { value: starTex },
      uTime: { value: 0 },
      uScale: { value: 1 },
      uDpr: { value: 1 },
      uMouse: { value: new THREE.Vector2() },
      uPlane: { value: new THREE.Vector2(1, 1) },
      uParallax: { value: PARALLAX },
      uShade: { value: place.shade },
    }),
    [starTex, place.shade],
  );

  useFrame(() => {
    // the tilt is in screen space; turn it into this rose's own frame
    const local = clock.current.mouse.clone().rotateAround(new THREE.Vector2(), -place.rot);
    if (place.flip) local.x = -local.x;
    const ru = roseMat.current?.uniforms;
    if (ru) {
      ru.uTime.value = clock.current.time;
      ru.uMouse.value.copy(local);
      ru.uTexel.value.set(1 / (aspect * s * unit * dpr), 1 / (s * unit * dpr));
    }
    const su = sparkleMat.current?.uniforms;
    if (su) {
      su.uTime.value = clock.current.time;
      su.uMouse.value.copy(local);
      su.uScale.value = (unit * s) / meta.height;
      su.uDpr.value = dpr;
    }
  });

  return (
    <group ref={layer}>
      <group rotation={[0, 0, place.rot]}>
        <group position={[0, place.lift, 0]} scale={[place.flip ? -1 : 1, 1, 1]}>
          {/* move the picture so its tie point sits on the origin */}
          <group position={[(0.5 - TIE.u) * aspect * s, (TIE.v - 0.5) * s, 0]} scale={[aspect * s, s, 1]}>
            <mesh renderOrder={order}>
              <planeGeometry args={[1, 1]} />
              <shaderMaterial
                ref={roseMat}
                uniforms={roseUniforms}
                vertexShader={roseVertex}
                fragmentShader={shadedRoseFragment}
                transparent
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            {!still && (
              <points geometry={sparkles} renderOrder={order + 0.5}>
                <shaderMaterial
                  ref={sparkleMat}
                  uniforms={sparkleUniforms}
                  vertexShader={sparkleVertex}
                  fragmentShader={shadedSparkleFragment}
                  transparent
                  depthWrite={false}
                  depthTest={false}
                  blending={THREE.AdditiveBlending}
                />
              </points>
            )}
          </group>
        </group>
      </group>
    </group>
  );
}

/** Extent of the bunch in rose heights, so it can be fitted to the screen. */
function bounds(aspect: number) {
  const box = new THREE.Box2();
  const v = new THREE.Vector2();
  for (const p of ROSES) {
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      v.set((cx - TIE.u) * aspect * p.s * (p.flip ? -1 : 1), (TIE.v - cy) * p.s + p.lift);
      box.expandByPoint(v.rotateAround(new THREE.Vector2(), p.rot));
    }
  }
  // the picture corners are mostly empty glow; trim them back to the flowers
  box.expandByScalar(-0.08);
  for (const pts of [BACK_SHEET, SLEEVE, TAIL_L, TAIL_R]) for (const [x, y] of pts) box.expandByPoint(v.set(x, y));
  return box;
}

function Bouquet({ meta, still, insetTop, insetBottom, ...tex }: { meta: Meta; still: boolean; insetTop: number; insetBottom: number } & Textures) {
  const size = useThree((s) => s.size);
  const target = useMouse(still);
  const clock = useRef<Clock>({ time: 0, mouse: new THREE.Vector2() });
  const starTex = useMemo(() => createStarTexture(), []);
  useEffect(() => () => starTex.dispose(), [starTex]);

  const box = useMemo(() => bounds(meta.width / meta.height), [meta]);
  const bw = box.max.x - box.min.x;
  const bh = box.max.y - box.min.y;
  const avail = size.height - insetTop - insetBottom;
  const unit = Math.min(size.width / bw, avail / bh) * 0.96;
  const cx = -(box.min.x + bw / 2) * unit;
  const cy = -(box.min.y + bh / 2) * unit + (insetBottom - insetTop) / 2;

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    // ease toward the pointer; a slow idle sway when it rests
    const idle = still ? 0 : 0.25;
    const goal = new THREE.Vector2(
      target.current.x + idle * Math.sin(t * 0.45),
      target.current.y + idle * 0.5 * Math.sin(t * 0.31 + 1),
    );
    clock.current.time = t;
    clock.current.mouse.lerp(goal, 1 - Math.exp(-delta * 4));
  });

  const last = ROSES.length - 1;
  return (
    <group position={[cx, cy, 0]} scale={[unit, unit, 1]}>
      <Paper pts={BACK_SHEET} tint="#efe0ea" alpha={0.34} shade={0.8} seed={1} depth={0} order={0} clock={clock} />
      {ROSES.map((place, i) => (
        <BouquetRose
          key={i}
          meta={meta}
          still={still}
          place={place}
          unit={unit}
          order={1 + i}
          // rows sit at increasing depth, front row nearest
          depth={0.15 + (0.6 * i) / last}
          starTex={starTex}
          clock={clock}
          {...tex}
        />
      ))}
      <Paper pts={SLEEVE} tint="#e6dcec" alpha={0.82} seed={4} depth={0.8} order={20} clock={clock} />
      <Paper pts={LEFT_SHEET} tint="#f4e2ec" alpha={0.66} seed={2} depth={0.85} order={21} clock={clock} />
      <Paper pts={RIGHT_SHEET} tint="#e4def4" alpha={0.66} seed={3} depth={0.9} order={22} clock={clock} />
      <Bow order={30} clock={clock} />
    </group>
  );
}

function Loaded({ still, insetTop, insetBottom }: { still: boolean; insetTop: number; insetBottom: number }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const tex = useRoseTextures();
  useEffect(() => {
    fetch(`${ASSETS}/rose.json`)
      .then((r) => r.json())
      .then(setMeta);
  }, []);
  return (
    <>
      <color attach="background" args={[meta?.background ?? BACKDROP]} />
      {meta && tex && <Bouquet meta={meta} still={still} insetTop={insetTop} insetBottom={insetBottom} {...tex} />}
    </>
  );
}

export default function BouquetScene({
  still = false,
  insetTop = 0,
  insetBottom = 0,
}: {
  still?: boolean;
  /** screen pixels kept clear above and below the bunch */
  insetTop?: number;
  insetBottom?: number;
}) {
  return (
    <Canvas flat orthographic dpr={[1, 2]} camera={{ position: [0, 0, 10], zoom: 1 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <Loaded still={still} insetTop={insetTop} insetBottom={insetBottom} />
    </Canvas>
  );
}

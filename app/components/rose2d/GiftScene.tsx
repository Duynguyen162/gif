"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  type Clock,
  flatVertex,
  KNOT,
  LOOP_L,
  LOOP_R,
  paperFragment,
  satinFragment,
  shapeGeometry,
  strokeGeometry,
  TAIL_L,
  TAIL_R,
  TIE,
  useLayerShift,
} from "./BouquetScene";
import { BACK_PETALS, BAND, END, HEART, PETAL, PETALS, pose, type Pose, SLEEVE, type Xform } from "./giftTimeline";
import { type Pt } from "./outline";
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
import { createStarTexture } from "./starTexture";

// Same frame as the bouquet: rose heights, origin at the neck of the parcel.
// Every moving part reads its pose from giftTimeline.ts once per frame.

type GiftClock = Clock & { pose: Pose; t: number | null };

// --- shaders ---------------------------------------------------------------

/** the rose shader, appearing from its heart outward behind a rim of molten gold */
const revealRoseFragment = roseFragment
  .replace("uniform vec2 uRes;", "uniform vec2 uRes;\nuniform float uReveal;\nuniform float uFlash;\nuniform vec2 uHeart;\nuniform float uAspect;")
  .replace(
    "gl_FragColor = c;",
    `vec2 hd = (vUv - uHeart) * vec2(uAspect, 1.0);
  float edge = uReveal - length(hd) + 0.015 * sin(atan(hd.y, hd.x) * 7.0 + uTime * 2.0) + 0.01 * (hash(floor(vUv * 90.0)) - 0.5);
  float rim = exp(-pow(edge * 28.0, 2.0)) * step(0.001, uReveal);
  float body = c.a;
  c.a = max(body * smoothstep(0.0, 0.025, edge), rim * body * 0.9);
  c.rgb += rim * vec3(1.0, 0.8, 0.45) * 1.2 + uFlash * 0.22;
  gl_FragColor = c;`,
  );

/** the rose's sparkles switch on, with a little pop, as the rim passes them */
const revealSparkleVertex = sparkleVertex
  .replace("attribute float aSize;", "uniform float uReveal;\nuniform vec2 uHeart;\nuniform float uAspect;\nattribute float aSize;")
  .replace(
    "vAlpha = mix(0.15, 1.0, tw);",
    `vAlpha = mix(0.15, 1.0, tw);
  float lag = uReveal - length((position.xy - uHeart) * vec2(uAspect, 1.0));
  vAlpha *= smoothstep(0.0, 0.06, lag);`,
  )
  .replace(
    "gl_PointSize = aSize * uScale * uDpr * mix(0.35, 1.0, tw);",
    "gl_PointSize = aSize * uScale * uDpr * mix(0.35, 1.0, tw) * (1.0 + 1.5 * exp(-pow(lag * 18.0, 2.0)) * step(0.0, lag));",
  );

const fadingSatinFragment = satinFragment
  .replace("varying vec2 vPos;", "varying vec2 vPos;\nuniform float uOpacity;")
  .replace("gl_FragColor = vec4(c, 1.0);", "gl_FragColor = vec4(c, uOpacity);");

/** glow inside the parcel, then rays and a ring of light when it opens */
const lightFragment = /* glsl */ `
uniform float uTime;
uniform float uGlow;
uniform float uRays;
uniform float uRing;
uniform float uRingAlpha;
varying vec2 vPos;
void main() {
  float r = length(vPos);
  float ang = atan(vPos.y, vPos.x);
  float rays = pow(0.5 + 0.5 * sin(ang * 9.0 + uTime * 0.6), 6.0) * 0.6
             + pow(0.5 + 0.5 * sin(ang * 14.0 - uTime * 0.4 + 1.0), 8.0) * 0.4;
  float l = rays * exp(-r * 2.2) * uRays + exp(-r * 6.0) * uGlow + exp(-pow((r - uRing) * 14.0, 2.0)) * uRingAlpha;
  gl_FragColor = vec4(vec3(1.0, 0.88, 0.62) * l, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * Every particle flies on a closed-form path from its birth time, so nothing
 * is simulated on the CPU. Kinds: 0 burst stars, 1 dust from the knot,
 * 2 glitter rain, 3 dust circling the waiting parcel, 4 a light drizzle after.
 */
const particleVertex = /* glsl */ `
uniform float uT;
uniform float uTime;
uniform float uScale;
uniform float uBurst;
attribute float aKind;
attribute float aStart;
attribute float aLife;
attribute float aSize;
attribute float aSeed;
attribute vec2 aVel;
attribute vec3 aColor;
varying float vAlpha;
varying float vFlake;
varying float vSpin;
varying vec3 vColor;
void main() {
  vec2 p = position.xy;
  float a = 0.0;
  float age = uT - aStart;
  float tw = 0.5 + 0.5 * sin(uTime * (3.0 + aSeed * 5.0) + aSeed * 40.0);
  vFlake = 0.0;
  vSpin = 0.0;
  if (aKind < 1.5) {
    // thrown out, slowed by drag, sinking a little
    float k = aKind < 0.5 ? 2.2 : 4.0;
    p += aVel * (1.0 - exp(-k * age)) / k + vec2(0.0, -0.06) * age * age;
    a = step(0.0, age) * (1.0 - smoothstep(aLife * 0.5, aLife, age)) * mix(0.4, 1.0, tw) * uBurst;
  } else if (aKind < 2.5 || aKind > 3.5) {
    // drifting down, swaying, flakes flipping over
    if (aKind > 3.5) age = uT < aStart ? -1.0 : mod(uT - aStart, aLife);
    p += vec2(sin(age * 1.3 + aSeed * 6.28) * 0.06, aVel.y * age);
    a = step(0.0, age) * smoothstep(0.0, 0.4, age) * (1.0 - smoothstep(aLife * 0.7, aLife, age));
    if (aKind > 3.5) a *= 0.6;
    vFlake = 1.0;
    vSpin = age * aVel.x + aSeed * 6.28;
  } else {
    // circling the parcel while it waits
    float ang = uTime * aVel.x + aSeed * 6.28;
    p = vec2(cos(ang) * position.x, 0.4 + sin(ang) * position.y + 0.04 * sin(uTime * 1.3 + aSeed * 9.0));
    a = (uT < 0.0 ? 1.0 : 1.0 - smoothstep(0.0, 1.2, uT)) * mix(0.2, 1.0, tw);
  }
  vAlpha = a;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
  gl_PointSize = a > 0.001 ? aSize * uScale * mix(0.6, 1.0, tw) : 0.0;
}`;

const particleFragment = /* glsl */ `
uniform sampler2D uTex;
varying float vAlpha;
varying float vFlake;
varying float vSpin;
varying vec3 vColor;
void main() {
  if (vFlake > 0.5) {
    // a small foil flake, turning so it narrows and catches the light
    vec2 q = gl_PointCoord - 0.5;
    float c = cos(vSpin), s = sin(vSpin);
    q = mat2(c, -s, s, c) * q;
    float flip = abs(cos(vSpin * 1.7));
    float inside = step(abs(q.x), 0.22 * flip + 0.02) * step(abs(q.y), 0.12);
    vec3 col = vColor * (0.6 + 0.6 * flip);
    gl_FragColor = vec4(col, inside * vAlpha);
  } else {
    vec4 t = texture2D(uTex, gl_PointCoord);
    gl_FragColor = vec4(vColor * t.rgb * 1.4, t.a * vAlpha);
  }
}`;

// --- helpers ---------------------------------------------------------------

function setXform(o: THREE.Object3D, x: Xform) {
  o.position.set(x.x, x.y, 0);
  o.rotation.set(0, 0, x.rot);
  o.scale.set(x.sx, x.sy, 1);
}

const applyXform = (x: Xform, [px, py]: Pt): Pt => {
  const c = Math.cos(x.rot);
  const s = Math.sin(x.rot);
  const sx = px * x.sx;
  const sy = py * x.sy;
  return [x.x + c * sx - s * sy, x.y + s * sx + c * sy];
};

/** where the heart of the rose is, in the parcel's frame */
function heartAt(p: Pose, aspect: number): Pt {
  const { s, lift, rot } = p.rose;
  return applyXform({ x: 0, y: 0, rot, sx: 1, sy: 1 }, [(HEART.u - TIE.u) * aspect * s, (TIE.v - HEART.v) * s + lift]);
}

/** small seeded random, so the particles land the same way every time */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- pieces ----------------------------------------------------------------

function Edge({ pts, order, width = 0.0045, mat }: { pts: Pt[]; order: number; width?: number; mat?: RefObject<THREE.MeshBasicMaterial | null> }) {
  const geo = useMemo(() => strokeGeometry(pts, width, true), [pts, width]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} renderOrder={order}>
      <meshBasicMaterial ref={mat} color="#e2bd78" transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** a cellophane sheet; `index` picks its pose, -1 is the fixed sleeve */
function Sheet({ pts, index, tint, seed, order, clock }: { pts: Pt[]; index: number; tint: string; seed: number; order: number; clock: RefObject<GiftClock> }) {
  const geo = useMemo(() => shapeGeometry(pts), [pts]);
  useEffect(() => () => geo.dispose(), [geo]);
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uTint: { value: new THREE.Color(tint) },
      uAlpha: { value: 0.82 },
      uShade: { value: 1 },
      uSeed: { value: seed },
    }),
    [tint, seed],
  );
  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u || !group.current) return;
    u.uTime.value = clock.current.time;
    u.uMouse.value.copy(clock.current.mouse);
    if (index < 0) return;
    const p = clock.current.pose.petals[index];
    setXform(group.current, p);
    u.uAlpha.value = p.alpha;
    u.uShade.value = p.shade;
    if (edge.current) edge.current.opacity = 0.5 + 0.4 * p.alpha;
  });
  return (
    <group ref={group}>
      <mesh geometry={geo} renderOrder={order}>
        <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={flatVertex} fragmentShader={paperFragment} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Edge pts={pts} order={order + 0.5} mat={edge} />
    </group>
  );
}

/** a piece of satin ribbon; `index` picks its pose in the bow, -1 stays put */
function Ribbon({ pts, index, grain, order, clock }: { pts: Pt[]; index: number; grain: Pt; order: number; clock: RefObject<GiftClock> }) {
  const geo = useMemo(() => shapeGeometry(pts), [pts]);
  useEffect(() => () => geo.dispose(), [geo]);
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uLight: { value: new THREE.Color("#f3dca6") },
      uDark: { value: new THREE.Color("#a8783a") },
      uGrain: { value: new THREE.Vector2(...grain) },
      uOpacity: { value: 1 },
    }),
    [grain],
  );
  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u || !group.current) return;
    u.uTime.value = clock.current.time;
    u.uMouse.value.copy(clock.current.mouse);
    if (index < 0) return;
    const p = clock.current.pose.bow[index];
    setXform(group.current, p);
    group.current.visible = p.alpha > 0.001;
    u.uOpacity.value = p.alpha;
    if (edge.current) edge.current.opacity = 0.8 * p.alpha;
  });
  return (
    <group ref={group}>
      <mesh geometry={geo} renderOrder={order}>
        <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={flatVertex} fragmentShader={fadingSatinFragment} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Edge pts={pts} order={order + 0.5} width={0.003} mat={edge} />
    </group>
  );
}

function Light({ aspect, order, clock }: { aspect: number; order: number; clock: RefObject<GiftClock> }) {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uGlow: { value: 0 }, uRays: { value: 0 }, uRing: { value: 0 }, uRingAlpha: { value: 0 } }), []);
  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u || !mesh.current) return;
    const { pose: p, time } = clock.current;
    const [x, y] = heartAt(p, aspect);
    mesh.current.position.set(x, y, 0);
    u.uTime.value = time;
    u.uGlow.value = p.light.glow;
    u.uRays.value = p.light.rays;
    u.uRing.value = p.light.ring;
    u.uRingAlpha.value = p.light.ringAlpha;
  });
  return (
    <mesh ref={mesh} renderOrder={order}>
      <planeGeometry args={[4, 4]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={flatVertex}
        fragmentShader={lightFragment}
        transparent
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

type RoseProps = { meta: Meta; still: boolean; unit: number; order: number; starTex: THREE.Texture; clock: RefObject<GiftClock> } & Textures;

function GiftRose({ meta, still, rose, fx, unit, order, starTex, clock }: RoseProps) {
  const dpr = useThree((s) => s.viewport.dpr);
  const turn = useRef<THREE.Group>(null);
  const slide = useRef<THREE.Group>(null);
  const roseMat = useRef<THREE.ShaderMaterial>(null);
  const sparkleMat = useRef<THREE.ShaderMaterial>(null);
  const aspect = meta.width / meta.height;

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
      uReveal: { value: 0 },
      uFlash: { value: 0 },
      uHeart: { value: new THREE.Vector2(HEART.u, 1 - HEART.v) },
      uAspect: { value: aspect },
    }),
    [rose, fx, still, meta.width, meta.height, aspect],
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
      phase[i] = (i * 2.399) % (Math.PI * 2);
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
  }, [meta]);
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
      uReveal: { value: 0 },
      uHeart: { value: new THREE.Vector2(HEART.u - 0.5, 0.5 - HEART.v) },
      uAspect: { value: aspect },
    }),
    [starTex, aspect],
  );

  useFrame(() => {
    const { pose: p, time, mouse } = clock.current;
    const { s, rot, lift, reveal, flash } = p.rose;
    turn.current?.rotation.set(0, 0, rot);
    slide.current?.position.set(0, lift, 0);
    slide.current?.scale.set(s, s, 1);
    const local = mouse.clone().rotateAround(new THREE.Vector2(), -rot);
    const ru = roseMat.current?.uniforms;
    if (ru) {
      ru.uTime.value = time;
      ru.uMouse.value.copy(local);
      ru.uTexel.value.set(1 / (aspect * s * unit * dpr), 1 / (s * unit * dpr));
      ru.uReveal.value = reveal;
      ru.uFlash.value = flash;
    }
    const su = sparkleMat.current?.uniforms;
    if (su) {
      su.uTime.value = time;
      su.uMouse.value.copy(local);
      su.uScale.value = (unit * s) / meta.height;
      su.uDpr.value = dpr;
      su.uReveal.value = reveal;
    }
  });

  return (
    <group ref={turn}>
      <group ref={slide}>
        {/* move the picture so its tie point sits on the neck */}
        <group position={[(0.5 - TIE.u) * aspect, TIE.v - 0.5, 0]} scale={[aspect, 1, 1]}>
          <mesh renderOrder={order}>
            <planeGeometry args={[1, 1]} />
            <shaderMaterial ref={roseMat} uniforms={roseUniforms} vertexShader={roseVertex} fragmentShader={revealRoseFragment} transparent depthWrite={false} />
          </mesh>
          {!still && (
            <points geometry={sparkles} renderOrder={order + 0.5}>
              <shaderMaterial
                ref={sparkleMat}
                uniforms={sparkleUniforms}
                vertexShader={revealSparkleVertex}
                fragmentShader={sparkleFragment}
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
  );
}

const GOLD = [1, 0.88, 0.62];
const FOILS = [
  [0.95, 0.78, 0.45],
  [1, 0.9, 0.7],
  [0.98, 0.75, 0.82],
  [0.92, 0.9, 1],
];

function Particles({ aspect, unit, reduced, clock }: { aspect: number; unit: number; reduced: boolean; clock: RefObject<GiftClock> }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const geo = useMemo(() => {
    const r = rng(7);
    const rows: { kind: number; p: Pt; v: Pt; start: number; life: number; size: number; color: number[] }[] = [];
    const [hx, hy] = heartAt(pose(2.6, 0), aspect);
    for (let i = 0; i < 220; i++) {
      // a fan of stars, mostly upward, from the heart
      const a = Math.PI / 2 + (r() - 0.5) * Math.PI * 1.7;
      const sp = 0.6 + r() * 1.6;
      rows.push({ kind: 0, p: [hx, hy], v: [Math.cos(a) * sp, Math.sin(a) * sp], start: 2.5 + r() * 0.25, life: 1.6 + r() * 1.4, size: 0.03 + r() * 0.05, color: GOLD });
    }
    for (let i = 0; i < 60; i++) {
      const a = r() * Math.PI * 2;
      const sp = 0.3 + r() * 0.7;
      rows.push({ kind: 1, p: [0, 0], v: [Math.cos(a) * sp, Math.sin(a) * sp], start: 0.95 + r() * 0.15, life: 0.8 + r() * 0.8, size: 0.02 + r() * 0.03, color: GOLD });
    }
    for (let i = 0; i < 160; i++) {
      rows.push({
        kind: 2,
        p: [(r() - 0.5) * 2, 1.05 + r() * 0.5],
        v: [2 + r() * 4, -(0.22 + r() * 0.2)],
        start: 3.6 + r() * 2.2,
        life: 5 + r() * 2,
        size: 0.022 + r() * 0.02,
        color: FOILS[i % FOILS.length],
      });
    }
    for (let i = 0; i < 26; i++) {
      rows.push({ kind: 3, p: [0.42 + r() * 0.12, 0.42 + r() * 0.14], v: [0.35 + r() * 0.4, 0], start: 0, life: 1, size: 0.025 + r() * 0.035, color: GOLD });
    }
    for (let i = 0; i < 36; i++) {
      rows.push({
        kind: 4,
        p: [(r() - 0.5) * 2, 1.05 + r() * 0.3],
        v: [2 + r() * 3, -(0.18 + r() * 0.12)],
        start: END + r() * 9,
        life: 9,
        size: 0.02 + r() * 0.015,
        color: FOILS[i % FOILS.length],
      });
    }
    const n = rows.length;
    const pos = new Float32Array(n * 3);
    const kind = new Float32Array(n);
    const start = new Float32Array(n);
    const life = new Float32Array(n);
    const size = new Float32Array(n);
    const seed = new Float32Array(n);
    const vel = new Float32Array(n * 2);
    const color = new Float32Array(n * 3);
    rows.forEach((row, i) => {
      pos.set([row.p[0], row.p[1], 0], i * 3);
      kind[i] = row.kind;
      start[i] = row.start;
      life[i] = row.life;
      size[i] = row.size;
      seed[i] = r();
      vel.set(row.v, i * 2);
      color.set(row.color, i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
    g.setAttribute("aStart", new THREE.BufferAttribute(start, 1));
    g.setAttribute("aLife", new THREE.BufferAttribute(life, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aVel", new THREE.BufferAttribute(vel, 2));
    g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    return g;
  }, [aspect]);
  useEffect(() => () => geo.dispose(), [geo]);

  const starTex = useMemo(() => createStarTexture(), []);
  useEffect(() => () => starTex.dispose(), [starTex]);
  const uniforms = useMemo(
    () => ({ uTex: { value: starTex }, uT: { value: -1 }, uTime: { value: 0 }, uScale: { value: 1 }, uBurst: { value: reduced ? 0 : 1 } }),
    [starTex, reduced],
  );
  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u) return;
    u.uT.value = clock.current.t ?? -1;
    u.uTime.value = clock.current.time;
    u.uScale.value = unit * dpr;
  });
  return (
    <points geometry={geo} renderOrder={40}>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={particleVertex}
        fragmentShader={particleFragment}
        transparent
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// --- the scene -------------------------------------------------------------

/** Extent of the parcel and of the opened gift, so neither leaves the screen. */
function bounds(aspect: number) {
  const box = new THREE.Box2();
  const v = new THREE.Vector2();
  for (const p of [pose(null, 0), pose(END, 0)]) {
    for (const petal of p.petals) for (const pt of PETAL) box.expandByPoint(v.set(...applyXform(petal, pt)));
    const { s, lift } = p.rose;
    // the picture corners are mostly glow; trim them back to the flower
    const trim = 0.08;
    for (const [cu, cv] of [
      [trim, trim],
      [1 - trim, trim],
      [1 - trim, 1 - trim],
      [trim, 1 - trim],
    ]) {
      box.expandByPoint(v.set((cu - TIE.u) * aspect * s, (TIE.v - cv) * s + lift));
    }
  }
  for (const pt of SLEEVE) box.expandByPoint(v.set(...pt));
  return box;
}

type GiftProps = {
  meta: Meta;
  still: boolean;
  play: number;
  freezeAt?: number;
  insetTop: number;
  insetBottom: number;
  onDone?: () => void;
} & Textures;

function Gift({ meta, still, play, freezeAt, insetTop, insetBottom, onDone, ...tex }: GiftProps) {
  const size = useThree((s) => s.size);
  const target = useMouse(still);
  const aspect = meta.width / meta.height;
  const clock = useRef<GiftClock>({ time: 0, mouse: new THREE.Vector2(), pose: pose(null, 0), t: null });
  const openedAt = useRef<number | null>(null);
  const pending = useRef(false);
  const reported = useRef(false);
  const [reduced, setReduced] = useState(false);
  const starTex = useMemo(() => createStarTexture(), []);
  useEffect(() => () => starTex.dispose(), [starTex]);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(q.matches);
    sync();
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);

  // a new `play` opens the parcel on the next frame; 0 wraps it up again
  useEffect(() => {
    openedAt.current = null;
    pending.current = play > 0;
    reported.current = false;
  }, [play]);

  const box = useMemo(() => bounds(aspect), [aspect]);
  const bw = box.max.x - box.min.x;
  const bh = box.max.y - box.min.y;
  const avail = size.height - insetTop - insetBottom;
  const unit = Math.min(size.width / bw, avail / bh) * 0.92;
  const cx = -(box.min.x + bw / 2) * unit;
  const cy = -(box.min.y + bh / 2) * unit + (insetBottom - insetTop) / 2;

  const parcel = useRef<THREE.Group>(null);
  const back = useLayerShift(0.2, clock);
  const middle = useLayerShift(0.5, clock);
  const front = useLayerShift(0.85, clock);

  useFrame((state, delta) => {
    const time = state.clock.elapsedTime;
    if (pending.current) {
      openedAt.current = time;
      pending.current = false;
    }
    let t = openedAt.current === null ? null : time - openedAt.current;
    if (still) t = END;
    else if (freezeAt !== undefined) t = freezeAt;
    const c = clock.current;
    c.time = time;
    c.t = t;
    c.pose = pose(t, time, reduced);
    if (parcel.current) setXform(parcel.current, c.pose.parcel);
    // ease toward the pointer; a slow idle sway when it rests
    const idle = still ? 0 : 0.25;
    const goal = new THREE.Vector2(target.current.x + idle * Math.sin(time * 0.45), target.current.y + idle * 0.5 * Math.sin(time * 0.31 + 1));
    c.mouse.lerp(goal, 1 - Math.exp(-delta * 4));
    if (t !== null && t >= END && !reported.current) {
      reported.current = true;
      onDone?.();
    }
  });

  return (
    <group position={[cx, cy, 0]} scale={[unit, unit, 1]}>
      <group ref={parcel}>
        <group ref={back}>
          {PETALS.slice(0, BACK_PETALS).map((_, i) => (
            <Sheet key={i} pts={PETAL} index={i} tint="#ece0ea" seed={1 + i} order={i} clock={clock} />
          ))}
        </group>
        <group ref={middle}>
          <Light aspect={aspect} order={5} clock={clock} />
          <GiftRose meta={meta} still={still} unit={unit} order={10} starTex={starTex} clock={clock} {...tex} />
        </group>
        <group ref={front}>
          <Sheet pts={SLEEVE} index={-1} tint="#e6dcec" seed={9} order={15} clock={clock} />
          {PETALS.slice(BACK_PETALS).map((_, i) => (
            <Sheet
              key={i}
              pts={PETAL}
              index={BACK_PETALS + i}
              tint={["#f4e2ec", "#e4def4", "#f1e6f0"][i]}
              seed={4 + i}
              order={20 + i}
              clock={clock}
            />
          ))}
          <Ribbon pts={BAND} index={-1} grain={[0, 0.6]} order={29} clock={clock} />
          <Ribbon pts={TAIL_L} index={0} grain={[0.4, 0.15]} order={30} clock={clock} />
          <Ribbon pts={TAIL_R} index={1} grain={[-0.4, 0.15]} order={31} clock={clock} />
          <Ribbon pts={LOOP_L} index={2} grain={[0.2, 0.5]} order={32} clock={clock} />
          <Ribbon pts={LOOP_R} index={3} grain={[-0.2, 0.5]} order={33} clock={clock} />
          <Ribbon pts={KNOT} index={4} grain={[0, 0.6]} order={34} clock={clock} />
        </group>
      </group>
      {!still && <Particles aspect={aspect} unit={unit} reduced={reduced} clock={clock} />}
    </group>
  );
}

type SceneProps = {
  still?: boolean;
  /** 0 keeps the parcel wrapped; every new value opens it from the start */
  play?: number;
  /** debug: hold the timeline at this many seconds after opening */
  freezeAt?: number;
  /** screen pixels kept clear above and below the gift */
  insetTop?: number;
  insetBottom?: number;
  /** the show has finished and the rose is live */
  onDone?: () => void;
};

function Loaded(props: Required<Pick<SceneProps, "still" | "play" | "insetTop" | "insetBottom">> & Pick<SceneProps, "freezeAt" | "onDone">) {
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
      {meta && tex && <Gift meta={meta} {...props} {...tex} />}
    </>
  );
}

export default function GiftScene({ still = false, play = 0, freezeAt, insetTop = 0, insetBottom = 0, onDone }: SceneProps) {
  return (
    <Canvas flat orthographic dpr={[1, 2]} camera={{ position: [0, 0, 10], zoom: 1 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <Loaded still={still} play={play} freezeAt={freezeAt} insetTop={insetTop} insetBottom={insetBottom} onDone={onDone} />
    </Canvas>
  );
}

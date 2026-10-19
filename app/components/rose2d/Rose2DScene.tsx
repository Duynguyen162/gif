"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { createStarTexture } from "./starTexture";

/** Written by tools/rose-fit/make2d.py next to the textures. */
export type Meta = {
  width: number;
  height: number;
  /** backdrop baked into an opaque source (seen through the glass); absent for transparent PNGs */
  background?: string;
  sparkles: { x: number; y: number; size: number; kind: "gold" | "glint"; depth: number }[];
};

export const ASSETS = "/rose2d";
/** depth that stays put while tilting (roughly the outer petal ring) */
export const PIVOT_DEPTH = 0.35;
export const PARALLAX = 0.014;
/** extra crispness when the picture is shown smaller than its 4× size */
export const SHARPEN = 0.6;

export type RoseLayout = "interactive" | "wish" | "background" | "showcase";

export const roseVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const roseFragment = /* glsl */ `
uniform sampler2D uRose;
uniform sampler2D uFx;   // r: gold, g: depth, b: petal
uniform float uTime;
uniform vec2 uMouse;
uniform float uParallax;
uniform float uFxOn;
uniform vec2 uRes;
uniform vec2 uTexel;     // one screen pixel in uv
uniform float uSharpen;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  // 2.5D tilt: shift each pixel by its depth; resample once for steadier edges
  float d = texture2D(uFx, vUv).g;
  vec2 uv = vUv + uMouse * (d - ${PIVOT_DEPTH}) * uParallax;
  d = texture2D(uFx, uv).g;
  uv = vUv + uMouse * (d - ${PIVOT_DEPTH}) * uParallax;

  vec4 c = texture2D(uRose, uv);
  // display sharpening: the 4x picture is minified with mipmaps, which softens
  // it slightly; push the centre away from its screen-pixel neighbourhood,
  // less where the local contrast is already high (keeps edges from ringing)
  vec3 n = texture2D(uRose, uv + vec2(uTexel.x, 0.0)).rgb + texture2D(uRose, uv - vec2(uTexel.x, 0.0)).rgb
         + texture2D(uRose, uv + vec2(0.0, uTexel.y)).rgb + texture2D(uRose, uv - vec2(0.0, uTexel.y)).rgb;
  vec3 detail = c.rgb - n * 0.25;
  float amount = uSharpen / (1.0 + 6.0 * length(detail));
  c.rgb = clamp(c.rgb + detail * amount, 0.0, 1.0);
  vec3 fx = texture2D(uFx, uv).rgb;

  // a band of light sweeping across the gilding, steered by the tilt
  float phase = (uv.x * 0.9 + (1.0 - uv.y) * 1.3) * 7.0 - uTime * 1.1 - uMouse.x * 3.0 + uMouse.y * 2.0;
  float sweep = pow(max(sin(phase), 0.0), 10.0);
  float grain = hash(floor(uv * uRes * 0.5) + floor(uTime * 6.0));
  float glitter = step(0.965, grain) * (0.6 + 0.4 * sin(uTime * 9.0 + grain * 40.0));
  c.rgb += uFxOn * fx.r * (sweep * 0.45 + glitter * 0.5) * vec3(1.0, 0.86, 0.55);

  // faint pearly sheen drifting over the petals
  float pearl = pow(max(sin(phase * 0.35 + 1.3), 0.0), 6.0);
  c.rgb += uFxOn * fx.b * pearl * 0.05 * vec3(1.0, 0.95, 0.98);

  gl_FragColor = c;
  #include <colorspace_fragment>
}`;

export const sparkleVertex = /* glsl */ `
uniform float uTime;
uniform float uScale;
uniform float uDpr;
uniform vec2 uMouse;
uniform vec2 uPlane;
uniform float uParallax;
attribute float aSize;
attribute float aPhase;
attribute float aSpeed;
attribute float aDepth;
attribute float aGlint;
varying float vAlpha;
void main() {
  vec3 p = position;
  // follow the same parallax as the image
  p.xy -= uMouse * (aDepth - ${PIVOT_DEPTH}) * uParallax * uPlane;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  float tw = pow(0.5 + 0.5 * sin(uTime * aSpeed + aPhase), mix(4.0, 2.0, aGlint));
  vAlpha = mix(0.15, 1.0, tw);
  gl_PointSize = aSize * uScale * uDpr * mix(0.35, 1.0, tw);
}`;

export const sparkleFragment = /* glsl */ `
uniform sampler2D uTex;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uTex, gl_PointCoord);
  gl_FragColor = vec4(vec3(1.0, 0.93, 0.74) * t.rgb * 1.4, t.a * vAlpha);
}`;

export function useMouse(still: boolean) {
  const target = useRef(new THREE.Vector2());
  useEffect(() => {
    if (still) {
      target.current.set(0, 0);
      return;
    }
    const move = (e: PointerEvent) => {
      target.current.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    };
    const leave = () => target.current.set(0, 0);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
    };
  }, [still]);
  return target;
}

export type Textures = { rose: THREE.Texture; fx: THREE.Texture };

/** Loads and configures the picture and its effect maps. */
export function useRoseTextures(): Textures | null {
  const gl = useThree((s) => s.gl);
  const [tex, setTex] = useState<Textures | null>(null);
  useEffect(() => {
    let alive = true;
    const loader = new THREE.TextureLoader();
    Promise.all([loader.loadAsync(`${ASSETS}/rose.webp`), loader.loadAsync(`${ASSETS}/fx.png`)]).then(([rose, fx]) => {
      rose.colorSpace = THREE.SRGBColorSpace;
      rose.anisotropy = gl.capabilities.getMaxAnisotropy();
      fx.colorSpace = THREE.NoColorSpace;
      if (alive) setTex({ rose, fx });
      else [rose, fx].forEach((t) => t.dispose());
    });
    return () => {
      alive = false;
    };
  }, [gl]);
  useEffect(
    () => () => {
      tex?.rose.dispose();
      tex?.fx.dispose();
    },
    [tex],
  );
  return tex;
}

function Rose2D({ meta, still, layout, rose, fx }: { meta: Meta; still: boolean; layout: RoseLayout } & Textures) {
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const [reduceMotion, setReduceMotion] = useState(false);
  const target = useMouse(still || reduceMotion);
  const mouse = useRef(new THREE.Vector2());
  const roseMat = useRef<THREE.ShaderMaterial>(null);
  const sparkleMat = useRef<THREE.ShaderMaterial>(null);
  const artwork = useRef<THREE.Group>(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Size and place the artwork inside WebGL instead of scaling the canvas.
  // This keeps the baked backdrop edge-to-edge in every story scene.
  const contain = Math.min(size.width / meta.width, size.height / meta.height) * 0.98;
  const heightFit = size.height / meta.height;
  const scale = layout === "interactive"
    ? Math.max(contain, heightFit * 0.86)
    : layout === "wish"
      ? Math.max(contain, heightFit * 0.88)
      : layout === "background"
        ? Math.max(contain, heightFit * 0.94)
        : contain * 1.02;
  // Trang lời chúc: tăng 0.23 để hạ hoa xuống; giảm số này để nâng hoa lên.
  const offsetY = layout === "wish"
    ? -size.height * 0.23
    : layout === "background"
      ? -size.height * 0.15
      : layout === "showcase"
        ? 0
        : -size.height * 0.06;
  const pw = meta.width * scale;
  const ph = meta.height * scale;

  const roseUniforms = useMemo(
    () => ({
      uRose: { value: rose },
      uFx: { value: fx },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
      uParallax: { value: PARALLAX },
      uFxOn: { value: still ? 0 : layout === 'showcase' ? 0.95 : 1 },
      uRes: { value: new THREE.Vector2(meta.width, meta.height) },
      uTexel: { value: new THREE.Vector2() },
      uSharpen: { value: SHARPEN },
    }),
    [rose, fx, still, layout, meta.width, meta.height],
  );

  const sparkles = useMemo(() => {
    const n = meta.sparkles.length;
    const pos = new Float32Array(n * 3);
    const sz = new Float32Array(n);
    const phase = new Float32Array(n);
    const sp = new Float32Array(n);
    const dp = new Float32Array(n);
    const glints = new Float32Array(n);
    meta.sparkles.forEach((s, i) => {
      pos.set([s.x - 0.5, 0.5 - s.y, 0.01], i * 3);
      const glint = s.kind === "glint" ? 1 : 0;
      // sizes as a share of the picture width, so any source resolution works
      sz[i] = (glint ? 0.072 : 0.024 + 0.039 * s.size) * meta.width;
      phase[i] = (i * 2.399) % (Math.PI * 2);
      sp[i] = 0.9 + ((i * 0.618) % 1) * 1.8;
      dp[i] = s.depth;
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
      uTex: { value: createStarTexture() },
      uTime: { value: 0 },
      uScale: { value: 1 },
      uDpr: { value: 1 },
      uMouse: { value: new THREE.Vector2() },
      uPlane: { value: new THREE.Vector2(1, 1) },
      uParallax: { value: PARALLAX },
    }),
    [],
  );
  useEffect(() => () => sparkleUniforms.uTex.value.dispose(), [sparkleUniforms]);

  useFrame((state, delta) => {
    const t = reduceMotion ? 0 : state.clock.elapsedTime;
    // ease toward the pointer; a slow idle sway when it rests
    const idle = still || reduceMotion ? 0 : 0.25;
    const goal = new THREE.Vector2(
      target.current.x + idle * Math.sin(t * 0.45),
      target.current.y + idle * 0.5 * Math.sin(t * 0.31 + 1),
    );
    mouse.current.lerp(goal, 1 - Math.exp(-delta * 4));
    if (artwork.current) {
      // A restrained, slow sway for the final close-up. The tiny angle keeps
      // the baked backdrop stable while making the bouquet feel alive.
      const sway = layout === 'showcase' && !reduceMotion ? Math.sin(t * 0.52) : 0;
      artwork.current.rotation.z = sway * 0.006;
      artwork.current.position.x = sway * size.width * 0.002;
    }
    const ru = roseMat.current?.uniforms;
    if (ru) {
      ru.uTime.value = t;
      ru.uMouse.value.copy(mouse.current);
      ru.uTexel.value.set(1 / (pw * dpr), 1 / (ph * dpr));
    }
    const su = sparkleMat.current?.uniforms;
    if (su) {
      su.uTime.value = t;
      su.uMouse.value.copy(mouse.current);
      su.uScale.value = scale;
      su.uDpr.value = dpr;
    }
  });

  return (
    <group ref={artwork} position={[0, offsetY, 0]}>
      <mesh scale={[pw, ph, 1]}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          ref={roseMat}
          uniforms={roseUniforms}
          vertexShader={roseVertex}
          fragmentShader={roseFragment}
          transparent
          depthWrite={false}
        />
      </mesh>
      {!still && (
        <points geometry={sparkles} scale={[pw, ph, 1]}>
          <shaderMaterial
            ref={sparkleMat}
            uniforms={sparkleUniforms}
            vertexShader={sparkleVertex}
            fragmentShader={sparkleFragment}
            transparent
            depthWrite={false}
            depthTest={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      )}
    </group>
  );
}

function Loaded({ still, layout }: { still: boolean; layout: RoseLayout }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const tex = useRoseTextures();
  useEffect(() => {
    fetch(`${ASSETS}/rose.json`)
      .then((r) => r.json())
      .then(setMeta);
  }, []);
  return (
    <>
      {meta && tex && <Rose2D meta={meta} still={still} layout={layout} {...tex} />}
    </>
  );
}

export default function Rose2DScene({ still = false, layout = "interactive" }: { still?: boolean; layout?: RoseLayout }) {
  return (
    <Canvas flat orthographic dpr={[1, 2]} camera={{ position: [0, 0, 10], zoom: 1 }} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}>
      <Loaded still={still} layout={layout} />
    </Canvas>
  );
}







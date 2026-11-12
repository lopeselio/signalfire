import { useEffect, useRef, useState } from 'react';
import type * as T from 'three';
import { api, type WireItem } from './api.ts';
import { reducedMotion } from './motion.tsx';

// The signal fire: the hub's activity drawn as a beacon. It is fed by the wire (what agents and people just did
// onchain), not decoration:
//   - its height and heat follow how many onchain actions landed in the last 24 hours;
//   - a buy through a creator's link throws a handful of sparks; a brief, a bid or a vote, a few;
//   - a milestone payout flares the whole fire for a moment (the beacon answering).
// three.js is loaded only when the fire is on screen. Without WebGL, or with reduced motion, a still flame is shown.

const SPARKS: Record<string, number> = { buy: 26, payout: 60, brief: 18, bid: 10, reveal: 8, vote: 12, settle: 14, pay: 6, vet: 8 };

const fireVertex = /* glsl */ `
  attribute vec4 seed;            // x offset, phase, speed, size
  uniform float uTime, uHeat, uFlare, uPixel;
  varying float vLife, vCore;
  void main() {
    float life = fract(uTime * (0.22 + seed.z * 0.34) + seed.y);
    float h = (2.2 + 3.0 * uHeat + 1.6 * uFlare) * (0.55 + 0.45 * seed.z);
    float taper = pow(1.0 - life, 1.35);
    float sway = sin(uTime * 1.7 + seed.y * 31.0 + life * 5.0) * 0.16 * life + sin(uTime * 0.6 + seed.y * 7.0) * 0.08;
    vec3 p = vec3(seed.x * (1.25 + 0.6 * uHeat) * taper + sway, life * h - 2.25, seed.w * 0.2 - 0.1);
    vLife = life;
    vCore = 1.0 - min(1.0, abs(seed.x) * 1.6);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (9.0 + 26.0 * seed.w) * (1.0 - life * 0.72) * (0.8 + 0.5 * uHeat + 0.5 * uFlare) * uPixel * (7.0 / -mv.z);
  }
`;
const fireFragment = /* glsl */ `
  uniform float uHeat, uFlare;
  varying float vLife, vCore;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 white = vec3(1.0, 0.93, 0.74), amber = vec3(1.0, 0.56, 0.12), ember = vec3(0.86, 0.2, 0.04), ash = vec3(0.3, 0.07, 0.03);
    vec3 c = mix(white, amber, smoothstep(0.0, 0.3, vLife + (1.0 - vCore) * 0.25));
    c = mix(c, ember, smoothstep(0.3, 0.7, vLife));
    c = mix(c, ash, smoothstep(0.7, 1.0, vLife));
    gl_FragColor = vec4(c * (0.5 + 0.35 * uHeat + 0.5 * uFlare), a * (1.0 - vLife) * 0.6);
  }
`;
const sparkVertex = /* glsl */ `
  attribute float age;            // 0 → 1, or > 1 when unused
  uniform float uPixel;
  varying float vAge;
  void main() {
    vAge = age;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (age > 1.0 ? 0.0 : 5.0 * (1.0 - age * 0.6)) * uPixel * (7.0 / -mv.z);
  }
`;
const sparkFragment = /* glsl */ `
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(mix(vec3(1.0, 0.9, 0.6), vec3(1.0, 0.4, 0.08), vAge), smoothstep(0.5, 0.05, d) * (1.0 - vAge));
  }
`;

interface Fire { setHeat(h: number): void; sparks(n: number): void; flare(): void; stop(): void }

function startFire(THREE: typeof T, canvas: HTMLCanvasElement): Fire | null {
  let renderer: T.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' }); } catch { return null; }
  const small = innerWidth < 720;
  const pixel = Math.min(devicePixelRatio || 1, small ? 1.5 : 2);
  renderer.setPixelRatio(pixel);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.35, 7);

  const N = small ? 520 : 900;
  const seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const r = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // bunched in the middle
    seed.set([r * 0.9, Math.random(), Math.random(), 0.25 + Math.random() * 0.75], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const uniforms = { uTime: { value: 0 }, uHeat: { value: 0.4 }, uFlare: { value: 0 }, uPixel: { value: pixel } };
  const flames = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: fireVertex, fragmentShader: fireFragment, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  flames.frustumCulled = false;
  scene.add(flames);

  const M = 220;
  const pos = new Float32Array(M * 3), vel = new Float32Array(M * 3), age = new Float32Array(M).fill(2);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sgeo.setAttribute('age', new THREE.BufferAttribute(age, 1));
  const sparks = new THREE.Points(sgeo, new THREE.ShaderMaterial({ vertexShader: sparkVertex, fragmentShader: sparkFragment, uniforms: { uPixel: uniforms.uPixel }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  let next = 0;

  const resize = (): void => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let onScreen = true, heat = 0.4, target = 0.4, flare = 0, raf = 0, last = performance.now();
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) wake(); });
  io.observe(canvas);
  const frame = (now: number): void => {
    raf = 0;
    if (!onScreen || document.hidden) return; // asleep until it is seen again
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    heat += (target - heat) * Math.min(1, dt * 1.5);
    flare = Math.max(0, flare - dt * 0.9);
    uniforms.uTime.value += dt;
    uniforms.uHeat.value = heat;
    uniforms.uFlare.value = flare;
    for (let i = 0; i < M; i++) {
      if (age[i] > 1) continue;
      age[i] += dt * 0.5;
      vel[i * 3] *= 1 - dt * 0.6;
      vel[i * 3 + 1] -= dt * 0.35;
      pos[i * 3] += vel[i * 3] * dt + Math.sin(now / 300 + i) * dt * 0.12;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
    }
    sgeo.attributes.position.needsUpdate = true;
    sgeo.attributes.age.needsUpdate = true;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  function wake(): void { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  const onVisible = (): void => { if (!document.hidden) wake(); };
  document.addEventListener('visibilitychange', onVisible);
  wake();

  return {
    setHeat(h) { target = Math.max(0.12, Math.min(1, h)); },
    sparks(n) {
      for (let k = 0; k < n; k++) {
        const i = next++ % M;
        pos.set([(Math.random() - 0.5) * 0.7, -1.7 + Math.random() * 0.8, 0], i * 3);
        vel.set([(Math.random() - 0.5) * 1.6, 1.6 + Math.random() * 2.4, 0], i * 3);
        age[i] = Math.random() * 0.15;
      }
      wake();
    },
    flare() { flare = 1; wake(); },
    stop() {
      cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      geo.dispose(); sgeo.dispose();
      (flames.material as T.Material).dispose(); (sparks.material as T.Material).dispose();
      renderer.dispose();
    },
  };
}

const DAY = 24 * 3600_000;
/** 0 actions → embers (0.15); 60 or more in a day (about three campaigns) → a full fire. */
export const heatOf = (actions: number): number => 0.15 + 0.85 * Math.min(1, actions / 60);

export function SignalFire() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fire = useRef<Fire | null>(null);
  const [still, setStill] = useState(() => reducedMotion());
  const [wire, setWire] = useState<WireItem[] | null>(null);
  const newest = useRef<number | null>(null);

  // the wire, every 6 s
  useEffect(() => {
    let on = true;
    const load = (): void => { api<WireItem[]>('/wire').then((w) => on && setWire(w)).catch(() => undefined); };
    load();
    const t = setInterval(load, 6000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // three.js, only once the fire is near the screen
  useEffect(() => {
    if (still || !wrap.current) return;
    let cancelled = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      void import('three').then((THREE) => {
        if (cancelled || !canvas.current) return;
        fire.current = startFire(THREE, canvas.current);
        if (!fire.current) setStill(true);
      }).catch(() => setStill(true));
    }, { rootMargin: '200px' });
    io.observe(wrap.current);
    return () => { cancelled = true; io.disconnect(); fire.current?.stop(); fire.current = null; };
  }, [still]);

  const now = Date.now();
  const recent = (wire ?? []).filter((w) => now - w.at < DAY && w.kind !== 'error');
  const heat = heatOf(recent.length);
  const last = wire?.find((w) => w.kind !== 'error');

  // feed the fire: its heat, and sparks for whatever landed since the last look
  useEffect(() => {
    if (!wire) return;
    fire.current?.setHeat(heat);
    const seen = newest.current;
    newest.current = wire[0]?.at ?? 0;
    if (seen === null) return; // first load: no burst for history
    for (const w of wire.filter((x) => x.at > seen).slice(0, 6)) {
      fire.current?.sparks(SPARKS[w.kind] ?? 6);
      if (w.kind === 'payout') fire.current?.flare();
    }
  }, [wire, heat]);

  const label = wire === null ? 'reading the wire' : `${recent.length} onchain action${recent.length === 1 ? '' : 's'} in the last 24 hours`;
  return (
    <div ref={wrap} className={`signalfire${still ? ' still' : ''}`} style={{ ['--heat' as string]: heat.toFixed(2) }}>
      <div className="sf-stage" role="img" aria-label={`The signal fire: ${label}`}>
        {still
          ? <svg className="sf-still" viewBox="0 0 120 150" aria-hidden="true"><path d="M60 6c16 24 38 40 38 74a38 38 0 0 1-76 0c0-21 15-32 22-50 9 11 11 21 11 30 8-17 9-36 5-54z" fill="url(#sf-g)" /><defs><linearGradient id="sf-g" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stopColor="#ffe9bd" /><stop offset="0.45" stopColor="#ff8f1f" /><stop offset="1" stopColor="#c8370a" /></linearGradient></defs></svg>
          : <canvas ref={canvas} />}
        <span className="sf-bowl" aria-hidden="true" />
      </div>
      <p className="sf-cap">
        <span className="live" aria-hidden="true" />
        <span><strong>{label}</strong>{last && <span className="sf-last"> · latest: {last.who} {last.what.length > 64 ? `${last.what.slice(0, 62)}…` : last.what}</span>}</span>
      </p>
      <p className="sf-key">The fire burns higher with activity. Buys throw sparks; a milestone payout flares it.</p>
    </div>
  );
}

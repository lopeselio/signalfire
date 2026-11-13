import { useEffect, useRef, useState } from 'react';
import type * as T from 'three';
import { api, type WireItem } from './api.ts';
import { reducedMotion } from './motion.tsx';
import { FireMark, replay } from './FireMark.tsx';

// The signal fire: the hub's activity drawn as a beacon. It is fed by the wire (what agents and people just did
// onchain), not decoration:
//   - its height follows how many onchain actions landed in the last 24 hours;
//   - a buy through a creator's link puffs the flame and throws a handful of sparks; a brief, a bid or a vote, a few;
//   - a milestone payout flares the whole fire for a moment (the beacon answering).
// The flame itself is the flat flame mark (FireMark.tsx, CSS-animated). three.js draws only what flies off it:
// embers that rise more thickly as the fire grows, and the sparks. three is loaded only when the fire is on screen
// and sleeps off-screen. Without WebGL, or with reduced motion, the flame stands still.

const SPARKS: Record<string, number> = { buy: 26, payout: 60, brief: 18, bid: 10, reveal: 8, vote: 12, settle: 14, pay: 6, vet: 8 };

// Both layers work in CSS pixels: an orthographic camera with x = 0 at the centre and y = 0 at the bottom.
const emberVertex = /* glsl */ `
  attribute vec4 seed;            // x offset, phase, speed, rank (the fire's heat decides how many show)
  uniform float uTime, uHeat, uFlare, uPixel, uBase, uH;
  varying float vLife;
  void main() {
    float life = fract(uTime * (0.22 + seed.z * 0.3) + seed.y);
    float on = step(seed.w, 0.15 + 0.85 * uHeat + uFlare);
    float x = seed.x * uH * 0.2 + sin(uTime * 1.4 + seed.y * 40.0 + life * 4.0) * 12.0 * life;
    float y = uBase + uH * (0.82 + 0.16 * fract(seed.y * 7.0)) + life * (36.0 + 90.0 * seed.z) * (1.0 + 0.8 * uFlare);
    vLife = life;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, 0.0, 1.0);
    gl_PointSize = on * (3.0 + 4.0 * seed.z) * (1.0 - life * 0.45) * uPixel;
  }
`;
const emberFragment = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    vec3 c = mix(vec3(1.0, 0.79, 0.24), vec3(0.95, 0.42, 0.11), smoothstep(0.25, 0.85, vLife));
    gl_FragColor = vec4(c, (1.0 - smoothstep(0.36, 0.5, d)) * smoothstep(0.0, 0.12, vLife) * (1.0 - vLife));
  }
`;
const sparkVertex = /* glsl */ `
  attribute float age;            // 0 → 1, or > 1 when unused
  uniform float uPixel;
  varying float vAge;
  void main() {
    vAge = age;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (age > 1.0 ? 0.0 : 6.0 * (1.0 - age * 0.55)) * uPixel;
  }
`;
const sparkFragment = /* glsl */ `
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    vec3 c = mix(vec3(1.0, 0.96, 0.84), mix(vec3(1.0, 0.79, 0.24), vec3(0.95, 0.42, 0.11), vAge), smoothstep(0.0, 0.3, vAge));
    gl_FragColor = vec4(c, (1.0 - smoothstep(0.36, 0.5, d)) * (1.0 - vAge * vAge));
  }
`;

interface Fire { setHeat(h: number): void; sparks(n: number): void; flare(): void; stop(): void }

function startFire(THREE: typeof T, canvas: HTMLCanvasElement, flame: () => Element | null): Fire | null {
  let renderer: T.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' }); } catch { return null; }
  const small = innerWidth < 720;
  const pixel = Math.min(devicePixelRatio || 1, small ? 1.5 : 2);
  renderer.setPixelRatio(pixel);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, 0, -10, 10);

  const N = small ? 48 : 80;
  const seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const r = (Math.random() + Math.random() - 1) / 1; // bunched in the middle
    seed.set([r, Math.random(), Math.random(), Math.random()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const uniforms = { uTime: { value: 0 }, uHeat: { value: 0.4 }, uFlare: { value: 0 }, uPixel: { value: pixel }, uBase: { value: 12 }, uH: { value: 120 } };
  const embers = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: emberVertex, fragmentShader: emberFragment, uniforms, transparent: true, depthWrite: false }));
  embers.frustumCulled = false;
  scene.add(embers);

  const M = 220;
  const pos = new Float32Array(M * 3), vel = new Float32Array(M * 3), age = new Float32Array(M).fill(2);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sgeo.setAttribute('age', new THREE.BufferAttribute(age, 1));
  const sparks = new THREE.Points(sgeo, new THREE.ShaderMaterial({ vertexShader: sparkVertex, fragmentShader: sparkFragment, uniforms: { uPixel: uniforms.uPixel }, transparent: true, depthWrite: false }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  let next = 0;

  const resize = (): void => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.left = -w / 2; camera.right = w / 2; camera.top = h; camera.bottom = 0;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // where the flame mark stands, in canvas pixels (it grows and shrinks with the heat)
  const measure = (): void => {
    const f = flame();
    if (!f) return;
    const c = canvas.getBoundingClientRect(), r = f.getBoundingClientRect();
    uniforms.uBase.value = c.bottom - r.bottom;
    uniforms.uH.value = r.height;
  };

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
    measure();
    for (let i = 0; i < M; i++) {
      if (age[i] > 1) continue;
      age[i] += dt * 0.6;
      vel[i * 3] *= 1 - dt * 0.8;
      vel[i * 3 + 1] -= dt * 340;
      pos[i * 3] += vel[i * 3] * dt + Math.sin(now / 300 + i) * dt * 14;
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
      const base = uniforms.uBase.value, h = uniforms.uH.value;
      for (let k = 0; k < n; k++) {
        const i = next++ % M;
        pos.set([(Math.random() - 0.5) * h * 0.4, base + h * (0.45 + Math.random() * 0.35), 0], i * 3);
        vel.set([(Math.random() - 0.5) * 260, 200 + Math.random() * 260, 0], i * 3);
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
      (embers.material as T.Material).dispose(); (sparks.material as T.Material).dispose();
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
  const stage = useRef<HTMLDivElement>(null);
  const fire = useRef<Fire | null>(null);
  const [still, setStill] = useState(() => reducedMotion());
  const [puff, setPuff] = useState(0);
  const [flare, setFlare] = useState(0);
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
        fire.current = startFire(THREE, canvas.current, () => stage.current?.querySelector('.sf-flame') ?? null);
        if (!fire.current) setStill(true);
      }).catch(() => setStill(true));
    }, { rootMargin: '200px' });
    io.observe(wrap.current);
    return () => { cancelled = true; io.disconnect(); fire.current?.stop(); fire.current = null; };
  }, [still]);

  // the flame mark's idle motion sleeps while the fire is off screen
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => el.classList.toggle('asleep', !e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
    const fresh = wire.filter((x) => x.at > seen).slice(0, 6);
    for (const w of fresh) fire.current?.sparks(SPARKS[w.kind] ?? 6);
    if (still || !fresh.length) return;
    if (fresh.some((w) => w.kind === 'payout')) {
      fire.current?.flare();
      setFlare((n) => n + 1);
      replay(stage.current, 'flaring');
    } else setPuff((n) => n + 1);
  }, [wire, heat, still]);

  const label = wire === null ? 'loading live activity' : `${recent.length} action${recent.length === 1 ? '' : 's'} on NEAR in the last 24 hours`;
  return (
    <div ref={wrap} data-tour="fire" className={`signalfire${still ? ' still' : ''}`} style={{ ['--heat' as string]: heat.toFixed(2) }}>
      <div ref={stage} className="sf-stage" role="img" aria-label={`The signal fire: ${label}`}>
        <FireMark className="sf-flame" still={still} puff={puff} flare={flare} />
        <span className="sf-bowl" aria-hidden="true" />
        {!still && <canvas ref={canvas} aria-hidden="true" />}
      </div>
      <p className="sf-cap">
        <span className="live" aria-hidden="true" />
        <span><strong>{label}</strong>{last && <span className="sf-last"> · latest: {last.who} {last.what.length > 64 ? `${last.what.slice(0, 62)}…` : last.what}</span>}</span>
      </p>
      <p className="sf-key">The fire burns higher with activity. Buys throw sparks; a milestone payout flares it.</p>
    </div>
  );
}

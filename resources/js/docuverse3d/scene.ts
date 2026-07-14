/**
 * The Three.js scene for the docuverse. Loaded via dynamic import from
 * main.ts AFTER the first data fetch (page shell paints before three's chunk
 * downloads). Rebuilt wholesale when the viewer changes connection layers OR
 * theme — startScene returns a dispose() so main.ts can tear down and
 * re-enter. This module (+ interaction) is the only place three is imported.
 *
 * PALETTE: read from the CSS custom properties on <body> (--dv-node-*,
 * --dv-edge-*, --color-*) — defined in resources/css/pages/docuverse.css and
 * re-tinted per theme by the shared theme files. Recolour there, not here.
 * The one exception: the hypercite SPECTRUM stops (pink → orange → aqua →
 * pink, the reader's hypercite-underline ramp) are read from the brand vars.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { DocuversePayload, DocNode } from './types';
import { layoutDocuverse, yearAxis, degrees } from './layout';
import { attachInteraction } from './interaction';

function cssColor(varName: string, fallback: string): THREE.Color {
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return new THREE.Color(v || fallback);
}

/** The brand spectrum the hypercite underline uses, sampled at t ∈ [0,1]. */
function spectrumAt(t: number, stops: THREE.Color[]): THREE.Color {
  const span = stops.length - 1;
  const seg = Math.min(Math.floor(t * span), span - 1); // clamped in-bounds
  return stops[seg]!.clone().lerp(stops[seg + 1]!, t * span - seg);
}

/**
 * The ship for spaceship mode 🚀 — SPUTNIK: a mirror-polished sphere with
 * seam rings and four long antennae swept back at ~35°, plus one small
 * (gloriously ahistorical) thruster flame. Parented to the CAMERA (third
 * person: it hangs ahead of and below your eye, always framed). `envMap`
 * gives the chrome something to reflect — bare metalness renders black.
 * Returns the group + the exhaust flames so the flight loop can flare them.
 */
function buildShip(spectrum: THREE.Color[], envMap: THREE.Texture): { ship: THREE.Group; flames: THREE.Mesh[] } {
  const ship = new THREE.Group();
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xf2f2f2, metalness: 1, roughness: 0.1, envMap, envMapIntensity: 1.25,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.95, 48, 32), chrome);
  ship.add(body);

  // Panel seams: a polar ring (the photo's vertical band) + an equatorial one.
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x888888, metalness: 1, roughness: 0.35, envMap,
  });
  const seamA = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.012, 8, 72), seamMat);
  seamA.rotation.x = Math.PI / 2; // equator
  const seamB = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.012, 8, 72), seamMat);
  seamB.rotation.y = Math.PI / 2; // meridian
  ship.add(seamA, seamB);

  // Four whip antennae, swept BACK (+z is the tail here) at ~35° off the
  // flight axis, one per quadrant — the Sputnik silhouette.
  const antennaDirs = [45, 135, 225, 315].map((az) => {
    const a = (az * Math.PI) / 180;
    const sweep = (35 * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(sweep) * Math.cos(a), Math.sin(sweep) * Math.sin(a), Math.cos(sweep)).normalize();
  });
  const ANT_LEN = 7.5;
  antennaDirs.forEach((dir) => {
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.022, ANT_LEN, 6), chrome);
    antenna.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    antenna.position.copy(dir.clone().multiplyScalar(0.9 + ANT_LEN / 2 - 0.1));
    ship.add(antenna);
  });

  // The thruster Korolev never fitted: one orange flame + pink core out the
  // back, additive so they GLOW against the void.
  const flames: THREE.Mesh[] = [];
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 1.5, 10),
    new THREE.MeshBasicMaterial({
      color: spectrum[1], transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  flame.rotation.x = -Math.PI / 2; // tail out the back (+z)
  flame.position.set(0, 0, 1.9);
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 1.0, 8),
    new THREE.MeshBasicMaterial({
      color: spectrum[0], transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  core.rotation.x = -Math.PI / 2;
  core.position.set(0, 0, 1.65);
  ship.add(flame, core);
  flames.push(flame, core);

  // Third-person seat: ahead of and below the camera eye, antennae trailing.
  ship.position.set(0, -2.3, -11);
  ship.visible = false; // fly mode only
  return { ship, flames };
}

function nodeRadius(node: DocNode, degree: number): number {
  const cited = Math.max(0, node.cited_by_count ?? 0);
  // Size = global citedness, nudged by in-network degree.
  return (1 + 0.55 * Math.log10(1 + cited)) * (1 + 0.12 * Math.log2(1 + degree));
}

function yearSprite(year: number, x: number, y: number, color: THREE.Color): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, 0.45)`;
  ctx.fillText(String(year), 64, 24);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }),
  );
  sprite.position.set(x, y, 0);
  sprite.scale.set(14, 5.25, 1);
  return sprite;
}

export function startScene(stage: HTMLElement, payload: DocuversePayload): () => void {
  const byId = new Map(payload.nodes.map((n) => [n.id, n]));
  // Guard: edges whose endpoint didn't resolve to a readable node are dropped.
  const edges = payload.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const positions = layoutDocuverse(payload);
  const deg = degrees(payload);

  // Theme-resolved palette (re-read on every scene build — a theme switch
  // rebuilds the scene from the cached payload, see main.ts).
  const textColor = cssColor('--color-text', '#cbcccc');
  const KIND_COLORS: Record<DocNode['kind'], THREE.Color> = {
    held: cssColor('--dv-node-held', '#4EACAE'),
    book: cssColor('--dv-node-book', '#EE4A95'),
    canonical: cssColor('--dv-node-canonical', '#EF8D34'),
  };
  // The hypercite underline's ramp: pink → orange → aqua → pink.
  const SPECTRUM = [
    cssColor('--hyperlit-pink', '#EE4A95'),
    cssColor('--hyperlit-orange', '#EF8D34'),
    cssColor('--hyperlit-aqua', '#4EACAE'),
    cssColor('--hyperlit-pink', '#EE4A95'),
  ];

  const scene = new THREE.Scene();
  scene.background = cssColor('--color-background', '#221f20');

  const camera = new THREE.PerspectiveCamera(55, stage.clientWidth / stage.clientHeight, 0.1, 3000);
  const ys = [...positions.values()].map((p) => p.y);
  const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  camera.position.set(0, midY + 25, 170);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.rotateSpeed = 0.55; // gentler than default — less lurch per drag
  controls.target.set(0, midY, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(60, 120, 100);
  scene.add(dir);

  const nodeMeshes: THREE.Mesh[] = [];
  payload.nodes.forEach((node) => {
    const pos = positions.get(node.id);
    if (!pos) return;
    // The focused work (/3d/{bookId}) is the theme-text standout, enlarged.
    const isFocus = node.id === payload.focus;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(nodeRadius(node, deg.get(node.id) ?? 0) * (isFocus ? 1.6 : 1), 24, 16),
      new THREE.MeshStandardMaterial({
        color: isFocus ? textColor : (KIND_COLORS[node.kind] ?? textColor),
        roughness: 0.55,
        metalness: 0.1,
      }),
    );
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.userData.node = node;
    nodeMeshes.push(mesh);
    scene.add(mesh);
  });

  // ── Edges ──
  // Hypercites: the brand SPECTRUM runs along each edge — subdivided segments
  // with vertex colours marching through the ramp (a 2-vertex line can only
  // fade between two colours; 16 segments give the full rainbow).
  const SPECTRUM_SEGS = 16;
  const hcVerts: number[] = [];
  const hcColors: number[] = [];
  // Citations: flat-colour 2-vertex segments, batched per kind.
  const flat = new Map<string, number[]>();

  edges.forEach((e) => {
    const a = positions.get(e.source)!;
    const b = positions.get(e.target)!;
    if (e.kind === 'hypercite') {
      for (let i = 0; i < SPECTRUM_SEGS; i++) {
        const t0 = i / SPECTRUM_SEGS;
        const t1 = (i + 1) / SPECTRUM_SEGS;
        hcVerts.push(
          a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, a.z + (b.z - a.z) * t0,
          a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, a.z + (b.z - a.z) * t1,
        );
        const c0 = spectrumAt(t0, SPECTRUM);
        const c1 = spectrumAt(t1, SPECTRUM);
        hcColors.push(c0.r, c0.g, c0.b, c1.r, c1.g, c1.b);
      }
    } else {
      const arr = flat.get(e.kind) ?? flat.set(e.kind, []).get(e.kind)!;
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  });

  if (hcVerts.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(hcVerts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(hcColors, 3));
    scene.add(new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    ));
  }
  const FLAT_STYLE: Record<string, { color: THREE.Color; opacity: number }> = {
    citation_verified: { color: cssColor('--dv-edge-verified', '#4EACAE'), opacity: 0.55 },
    citation_auto: { color: cssColor('--dv-edge-auto', '#666666'), opacity: 0.3 },
  };
  flat.forEach((verts, kind) => {
    const style = FLAT_STYLE[kind] ?? { color: textColor, opacity: 0.4 };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    scene.add(new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: style.opacity }),
    ));
  });

  // Year axis on the floor plane (theme text colour, faint).
  const gridMaterial = new THREE.LineBasicMaterial({ color: textColor, transparent: true, opacity: 0.18 });
  const yTop = ys.length ? Math.max(...ys) + 12 : 12;
  yearAxis(payload).forEach(({ year, x }) => {
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, -6, 0),
        new THREE.Vector3(x, yTop, 0),
      ]),
      gridMaterial,
    ));
    scene.add(yearSprite(year, x, -12, textColor));
  });

  const detachInteraction = attachInteraction({ stage, camera, renderer, nodeMeshes });

  // ── Spaceship mode 🚀 ──
  // Orbit makes you a satellite around a fixed point — flying makes you a
  // reader loose in the docuverse. Pointer lock steers (mouse = look), WASD
  // (or arrows) thrusts in camera space, Space/C rise and sink, Shift boosts,
  // scroll trims cruise speed, Esc drops you back into orbit.
  const ORBIT_HINT = 'drag to orbit · scroll to zoom · right-drag to pan';
  const FLY_HINT = 'arrows steer · W thrusts · space boosts · A/D strafe · scroll speed · esc exits';
  const flyBtn = document.getElementById('dv-fly');
  const hintEl = document.getElementById('dv-controls-hint');
  const touchUi = document.getElementById('dv-fly-touch');
  const fly = {
    active: false,
    keys: new Set<string>(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    speed: 45, // scene units / second (X_SPAN is 160)
    yawVel: 0, // smoothed steering rate — banks the ship
    pitchVel: 0,
  };
  // The touch flight deck (thrust/boost buttons + joystick) feeds these.
  const touch = { thrust: false, boost: false, joyX: 0, joyY: 0 };

  // The ship rides as a CHILD of the camera (third person, always framed);
  // the camera must be in the scene graph for its children to render.
  // RoomEnvironment → PMREM gives Sputnik's chrome its studio reflections.
  scene.add(camera);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const { ship, flames } = buildShip(SPECTRUM, envTex);
  camera.add(ship);

  // Pointer lock is the good path (mouse = stick). Where it's unavailable or
  // refused (iPads, headless, odd browsers) fly mode still works: hold-drag
  // steers instead ("manual" mode), Esc or the 🚀 button exits either way.
  let manualFly = false;
  let dragSteer = false;

  const setFlyActive = (on: boolean): void => {
    fly.active = on;
    ship.visible = on;
    controls.enabled = !on;
    if (on) {
      fly.euler.setFromQuaternion(camera.quaternion); // take over from wherever orbit left you
    } else {
      manualFly = false;
      dragSteer = false;
      fly.keys.clear();
      touch.thrust = false;
      touch.boost = false;
      touch.joyX = 0;
      touch.joyY = 0;
      // Re-anchor orbit on the NEAREST WORK, not a blind point ahead — landing
      // in empty space left scroll-zoom dollying toward nothing (felt broken).
      let nearest: THREE.Vector3 | null = null;
      let best = Infinity;
      nodeMeshes.forEach((m) => {
        const d = m.position.distanceToSquared(camera.position);
        if (d < best) {
          best = d;
          nearest = m.position;
        }
      });
      controls.target.copy(
        nearest ?? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(60)),
      );
      controls.update();
    }
    stage.dataset.mode = on ? 'fly' : 'orbit'; // interaction.ts skips picking mid-flight
    flyBtn?.setAttribute('aria-pressed', String(on));
    // The touch flight deck appears only mid-flight on coarse pointers.
    if (touchUi) {
      touchUi.hidden = !(on && !!window.matchMedia?.('(pointer: coarse)').matches);
    }
    if (hintEl) {
      hintEl.textContent = on
        ? (manualFly ? FLY_HINT.replace('arrows steer', 'drag or arrows steer') : FLY_HINT)
        : ORBIT_HINT;
    }
  };
  const enterFly = (): void => {
    if (fly.active) {
      // 🚀 again = land.
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
      else setFlyActive(false);
      return;
    }
    if (renderer.domElement.requestPointerLock) {
      // Some browsers reject the PROMISE without firing pointerlockerror
      // (iOS: "root document not valid for pointer lock") — catch both paths.
      const req = renderer.domElement.requestPointerLock() as Promise<void> | undefined;
      req?.catch?.(() => onLockError());
      // pointerlockchange flips us active; pointerlockerror falls back below.
    } else {
      manualFly = true;
      setFlyActive(true);
    }
  };
  const onLockError = (): void => {
    if (fly.active) return; // promise-catch AND event both fired — once is enough
    manualFly = true;
    setFlyActive(true);
  };
  const onLockChange = (): void => {
    const locked = document.pointerLockElement === renderer.domElement;
    if (!locked && manualFly) return; // manual mode doesn't ride lock state
    setFlyActive(locked);
  };
  const onFlyLook = (event: MouseEvent): void => {
    if (!fly.active) return;
    if (manualFly && !dragSteer) return; // manual mode steers only while held
    fly.euler.y -= event.movementX * 0.0022;
    fly.euler.x -= event.movementY * 0.0022;
    fly.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, fly.euler.x));
    camera.quaternion.setFromEuler(fly.euler);
    fly.yawVel += event.movementX; // feeds the ship's bank
    fly.pitchVel += event.movementY;
  };
  const onDragStart = (): void => {
    if (fly.active && manualFly) dragSteer = true;
  };
  const onDragEnd = (): void => {
    dragSteer = false;
  };
  const onFlyEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && fly.active && manualFly) setFlyActive(false);
  };
  const onFlyKey = (down: boolean) => (event: KeyboardEvent): void => {
    if (!fly.active) return;
    fly.keys[down ? 'add' : 'delete'](event.code);
    if (down && ['KeyW', 'KeyA', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault(); // no page scroll on Space/arrows
    }
  };
  const onFlyWheel = (event: WheelEvent): void => {
    if (!fly.active) return;
    event.preventDefault();
    fly.speed = Math.min(400, Math.max(8, fly.speed * (event.deltaY > 0 ? 0.85 : 1.18)));
  };
  const STEER_RATE = 1.5; // rad/s at full arrow/stick deflection
  const flyStep = (dt: number, elapsed: number): void => {
    if (!fly.active) return;
    const k = fly.keys;

    // ── Steering: arrows or the touch joystick (mouse still steers when
    // pointer-locked, via onFlyLook). No backwards — you fly like a ship.
    const yawIn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0) - touch.joyX;
    const pitchIn = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0) + touch.joyY;
    if (yawIn !== 0 || pitchIn !== 0) {
      fly.euler.y += yawIn * STEER_RATE * dt;
      fly.euler.x += pitchIn * STEER_RATE * 0.8 * dt;
      fly.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, fly.euler.x));
      camera.quaternion.setFromEuler(fly.euler);
    }

    // ── Thrust: W (or the touch button); SPACE is the boost — alone it
    // punches it (boosted thrust), held with W it triples the burn.
    const boosting = k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight') || touch.boost;
    const thrust = k.has('KeyW') || k.has('Space') || touch.thrust ? 1 : 0;
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const dir = new THREE.Vector3(strafe, 0, -thrust);
    if (dir.lengthSq() > 0) {
      dir.normalize().applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(dir, fly.speed * (boosting ? 3 : 1) * dt);
    }

    // ── Ship theatre ──
    // Bank into turns (mouse rate + arrow/stick + strafe), pitch with the
    // stick; smoothed so it swings, not snaps.
    fly.yawVel *= 0.88;
    fly.pitchVel *= 0.88;
    const targetRoll = -fly.yawVel * 0.012 + yawIn * 0.45 - strafe * 0.45;
    const targetPitch = -fly.pitchVel * 0.006 - pitchIn * 0.22 + thrust * 0.06;
    ship.rotation.z += (targetRoll - ship.rotation.z) * Math.min(1, dt * 8);
    ship.rotation.x += (targetPitch - ship.rotation.x) * Math.min(1, dt * 8);

    // Fire the jets: idle simmer normally, long roaring flame under thrust,
    // longer again on boost, with a fast flicker so it reads as fire.
    const drive = thrust > 0 ? (boosting ? 2.1 : 1.4) : 0.35;
    flames.forEach((flame, i) => {
      const flicker = 1 + 0.22 * Math.sin(elapsed * 41 + i * 2.7) + 0.1 * Math.sin(elapsed * 97 + i);
      flame.scale.set(1, Math.max(0.05, drive * flicker), 1);
      (flame.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.55 + drive * 0.3 * flicker);
    });
  };

  // ── Touch flight deck wiring ──
  const joyBase = document.getElementById('dv-joystick');
  const joyKnob = joyBase?.querySelector<HTMLElement>('.dv-joystick-knob') ?? null;
  const onJoyMove = (event: PointerEvent): void => {
    if (!joyBase) return;
    const rect = joyBase.getBoundingClientRect();
    const r = rect.width / 2;
    let dx = event.clientX - (rect.left + r);
    let dy = event.clientY - (rect.top + r);
    const len = Math.hypot(dx, dy);
    const max = r * 0.62; // knob travel
    if (len > max) {
      dx *= max / len;
      dy *= max / len;
    }
    // Deadzone + quadratic response + 0.65 gain: a finger never lands
    // dead-center, and full arrow-rate from first contact hurled the camera
    // off the cluster instantly ("the spheres disappear"). Fine control near
    // center, gentle even at full deflection.
    const shape = (v: number): number => {
      const d = Math.abs(v) < 0.15 ? 0 : v;
      return d * Math.abs(d) * 0.65;
    };
    touch.joyX = shape(dx / max);
    touch.joyY = shape(-dy / max); // stick up = nose up
    if (joyKnob) joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  };
  const onJoyStart = (event: PointerEvent): void => {
    joyBase?.setPointerCapture(event.pointerId);
    onJoyMove(event);
  };
  const onJoyEnd = (): void => {
    touch.joyX = 0;
    touch.joyY = 0;
    if (joyKnob) joyKnob.style.transform = 'translate(-50%, -50%)';
  };
  const onJoyDrag = (e: PointerEvent): void => {
    if (joyBase?.hasPointerCapture?.(e.pointerId)) onJoyMove(e);
  };
  joyBase?.addEventListener('pointerdown', onJoyStart);
  joyBase?.addEventListener('pointermove', onJoyDrag);
  joyBase?.addEventListener('pointerup', onJoyEnd);
  joyBase?.addEventListener('pointercancel', onJoyEnd);

  const holdButton = (id: string, set: (on: boolean) => void): Array<[HTMLElement, string, () => void]> => {
    const el = document.getElementById(id);
    if (!el) return [];
    const wired: Array<[HTMLElement, string, () => void]> = [
      [el, 'pointerdown', () => set(true)],
      [el, 'pointerup', () => set(false)],
      [el, 'pointercancel', () => set(false)],
      [el, 'pointerleave', () => set(false)],
    ];
    wired.forEach(([node, evt, fn]) => node.addEventListener(evt, fn));
    return wired;
  };
  const touchButtons = [
    ...holdButton('dv-touch-thrust', (on) => { touch.thrust = on; }),
    ...holdButton('dv-touch-boost', (on) => { touch.boost = on; }),
  ];
  const onTouchExit = (): void => setFlyActive(false);
  document.getElementById('dv-touch-exit')?.addEventListener('click', onTouchExit);

  const flyKeyDown = onFlyKey(true);
  const flyKeyUp = onFlyKey(false);
  flyBtn?.addEventListener('click', enterFly);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);
  document.addEventListener('mousemove', onFlyLook);
  document.addEventListener('keydown', flyKeyDown);
  document.addEventListener('keyup', flyKeyUp);
  document.addEventListener('keydown', onFlyEscape);
  renderer.domElement.addEventListener('mousedown', onDragStart);
  document.addEventListener('mouseup', onDragEnd);
  renderer.domElement.addEventListener('wheel', onFlyWheel, { passive: false });
  setFlyActive(false);

  // ── View controls (the glass pill in the blade) ──
  // Zoom = dolly the camera along its line to the orbit target; reset restores
  // the opening framing. OrbitControls itself covers drag-orbit / scroll-zoom /
  // right-drag-pan (and touch: one-finger orbit, pinch zoom, two-finger pan).
  const homePos = camera.position.clone();
  const homeTarget = controls.target.clone();
  const dolly = (factor: number) => (): void => {
    camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
    controls.update();
  };
  const reset = (): void => {
    camera.position.copy(homePos);
    controls.target.copy(homeTarget);
    controls.update();
  };
  const bindings: Array<[string, () => void]> = [
    ['dv-zoom-in', dolly(0.72)],
    ['dv-zoom-out', dolly(1.4)],
    ['dv-reset', reset],
  ];
  bindings.forEach(([id, fn]) => document.getElementById(id)?.addEventListener('click', fn));

  const onResize = (): void => {
    camera.aspect = stage.clientWidth / stage.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(stage.clientWidth, stage.clientHeight);
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), 0.1); // clamp tab-switch jumps
    if (fly.active) {
      flyStep(dt, clock.elapsedTime);
    } else {
      controls.update();
    }
    renderer.render(scene, camera);
  });

  // Teardown for layer-change / theme-change rebuilds.
  return () => {
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    bindings.forEach(([id, fn]) => document.getElementById(id)?.removeEventListener('click', fn));
    flyBtn?.removeEventListener('click', enterFly);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('pointerlockerror', onLockError);
    document.removeEventListener('mousemove', onFlyLook);
    document.removeEventListener('keydown', flyKeyDown);
    document.removeEventListener('keyup', flyKeyUp);
    document.removeEventListener('keydown', onFlyEscape);
    renderer.domElement.removeEventListener('mousedown', onDragStart);
    document.removeEventListener('mouseup', onDragEnd);
    renderer.domElement.removeEventListener('wheel', onFlyWheel);
    joyBase?.removeEventListener('pointerdown', onJoyStart);
    joyBase?.removeEventListener('pointermove', onJoyDrag);
    joyBase?.removeEventListener('pointerup', onJoyEnd);
    joyBase?.removeEventListener('pointercancel', onJoyEnd);
    touchButtons.forEach(([node, evt, fn]) => node.removeEventListener(evt, fn));
    document.getElementById('dv-touch-exit')?.removeEventListener('click', onTouchExit);
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock?.();
    }
    setFlyActive(false);
    envTex.dispose();
    detachInteraction();
    controls.dispose();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    renderer.dispose();
    renderer.domElement.remove();
  };
}

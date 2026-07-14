/**
 * The Three.js scene for the harvest knowledge network. Loaded via dynamic
 * import from main.ts AFTER the data fetch, so the page shell paints before
 * three's chunk downloads. This module is the only place three is imported —
 * it must never be reachable from reader/home/user entries.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { NetworkNode, NetworkPayload } from './types';
import { layoutNetwork, yearAxis, LAYER_GAP } from './layout';
import { attachInteraction } from './interaction';

const STATUS_COLORS: Record<string, number> = {
  root: 0xe0e0e0,
  assigned: 0x27ae60,
  assigned_existing: 0x27ae60,
  skipped_over_budget: 0xf1c40f,
  deferred: 0xe67e22,
};
const FAIL_COLOR = 0xe74c3c;

function cssColor(varName: string, fallback: string): THREE.Color {
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return new THREE.Color(v || fallback);
}

function nodeRadius(node: NetworkNode): number {
  const cited = node.cited_by_count ?? 0;
  const base = node.status === 'root' ? 2.4 : 1.2;
  return base * (1 + 0.6 * Math.log10(1 + Math.max(0, cited)));
}

/** A year label rendered onto a canvas texture sprite. */
function yearSprite(year: number, x: number, y: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(224, 224, 224, 0.45)';
  ctx.fillText(String(year), 64, 24);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }),
  );
  sprite.position.set(x, y, 0);
  sprite.scale.set(12, 4.5, 1);
  return sprite;
}

export function startScene(stage: HTMLElement, payload: NetworkPayload): void {
  const positions = layoutNetwork(payload);
  const byId = new Map(payload.nodes.map((n) => [n.id, n]));

  const scene = new THREE.Scene();
  scene.background = cssColor('--color-background', '#1a1a2e');

  const camera = new THREE.PerspectiveCamera(
    55,
    stage.clientWidth / stage.clientHeight,
    0.1,
    2000,
  );
  const maxDepth = Math.max(...payload.nodes.map((n) => n.depth), 1);
  camera.position.set(0, -maxDepth * LAYER_GAP * 0.4, 130);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, -maxDepth * LAYER_GAP * 0.4, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(60, 80, 100);
  scene.add(dir);

  // Node spheres — individual meshes (tens to low hundreds; raycasting stays
  // trivial and per-node hover state is free).
  const nodeMeshes: THREE.Mesh[] = [];
  payload.nodes.forEach((node) => {
    const pos = positions.get(node.id);
    if (!pos) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(nodeRadius(node), 24, 16),
      new THREE.MeshStandardMaterial({
        color: STATUS_COLORS[node.status] ?? FAIL_COLOR,
        roughness: 0.55,
        metalness: 0.1,
      }),
    );
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.userData.node = node;
    nodeMeshes.push(mesh);
    scene.add(mesh);
  });

  // Citation edges — slightly arced beziers, faint.
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x888888,
    transparent: true,
    opacity: 0.45,
  });
  payload.edges.forEach((edge) => {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) return;
    const mid = new THREE.Vector3(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      (a.z + b.z) / 2 + 4,
    );
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(a.x, a.y, a.z),
      mid,
      new THREE.Vector3(b.x, b.y, b.z),
    );
    scene.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
        edgeMaterial,
      ),
    );
  });

  // Year axis: nice decimated ticks (labelling every distinct year mashed
  // the labels together whenever publications clustered), on the root plane.
  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0x555555,
    transparent: true,
    opacity: 0.25,
  });
  const yBottom = -(maxDepth + 0.6) * LAYER_GAP;
  yearAxis(payload).forEach(({ year, x }) => {
    scene.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, 6, 0),
          new THREE.Vector3(x, yBottom, 0),
        ]),
        gridMaterial,
      ),
    );
    scene.add(yearSprite(year, x, 10));
  });

  attachInteraction({ stage, camera, renderer, nodeMeshes, byId });

  window.addEventListener('resize', () => {
    camera.aspect = stage.clientWidth / stage.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(stage.clientWidth, stage.clientHeight);
  });

  // Render loop — parked while the tab is hidden.
  renderer.setAnimationLoop(() => {
    if (document.hidden) return;
    controls.update();
    renderer.render(scene, camera);
  });
}

/**
 * Hover tooltip + click selection for the docuverse scene — the same panel
 * pattern as the harvest network (click a sphere → citation details land in
 * the bottom-left panel with links; click empty space / × closes). Returns a
 * detach() so scene teardown (layer-change rebuild) removes the listeners.
 */

import * as THREE from 'three';
import type { DocNode } from './types';

interface InteractionDeps {
  stage: HTMLElement;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  nodeMeshes: THREE.Mesh[];
}

const KIND_LABELS: Record<DocNode['kind'], string> = {
  held: 'Canonical source — verified on an external database',
  // The pink bucket = ANY readable library row with no canonical link: user
  // originals, unlinked uploads, old web-fetched text. Don't claim more.
  book: 'Source — in hyperlit, not linked to an external record',
  canonical: 'Citation — no source material yet',
};

// var() strings — the DOM resolves them per theme (palette lives in docuverse.css).
const KIND_DOTS: Record<DocNode['kind'], string> = {
  held: 'var(--dv-node-held)',
  book: 'var(--dv-node-book)',
  canonical: 'var(--dv-node-canonical)',
};

function showPanel(node: DocNode): void {
  const panel = document.getElementById('dv-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const close = document.createElement('button');
  close.className = 'dv-panel-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => hidePanel());
  panel.appendChild(close);

  const citation = document.createElement('div');
  citation.className = 'dv-panel-citation';
  citation.appendChild(document.createTextNode(node.author ? `${node.author}, ` : ''));
  const i = document.createElement('i');
  i.textContent = node.title;
  citation.appendChild(i);
  if (node.year) citation.appendChild(document.createTextNode(` (${node.year})`));
  citation.appendChild(document.createTextNode('.'));
  panel.appendChild(citation);

  const status = document.createElement('div');
  status.className = 'dv-panel-status';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = KIND_DOTS[node.kind] ?? '#888';
  status.appendChild(dot);
  const bits = [KIND_LABELS[node.kind] ?? node.kind];
  if (node.cited_by_count) bits.push(`cited by ${node.cited_by_count.toLocaleString()}`);
  status.appendChild(document.createTextNode(bits.join(' · ')));
  panel.appendChild(status);

  const mkLink = (href: string, label: string): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    return a;
  };

  // A canonical is ONE sphere — when it holds several versions, touching it
  // lists them ALL; a single version keeps the plain read link.
  if ((node.versions?.length ?? 0) > 1) {
    const versions = document.createElement('div');
    versions.className = 'dv-panel-versions';
    const heading = document.createElement('div');
    heading.className = 'dv-panel-versions-title';
    heading.textContent = `${node.versions.length} versions in the library`;
    versions.appendChild(heading);
    node.versions.forEach((v) => {
      versions.appendChild(mkLink(`/${v.book}`, `${v.title} →`));
    });
    panel.appendChild(versions);
  }

  const links = document.createElement('div');
  links.className = 'dv-panel-links';
  if (node.book && (node.versions?.length ?? 0) <= 1) {
    links.appendChild(mkLink(`/${node.book}`, 'Read in Hyperlit →'));
  }
  if (node.url) {
    links.appendChild(mkLink(node.url, 'External source ↗'));
  }
  if (links.childElementCount) panel.appendChild(links);

  panel.hidden = false;
}

function hidePanel(): void {
  const panel = document.getElementById('dv-panel');
  if (panel) panel.hidden = true;
}

export function attachInteraction(deps: InteractionDeps): () => void {
  const { stage, camera, renderer, nodeMeshes } = deps;
  const tooltip = document.getElementById('dv-tooltip');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selected: THREE.Mesh | null = null;

  const pick = (event: PointerEvent | MouseEvent): THREE.Mesh | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(nodeMeshes, false)[0];
    return (hit?.object as THREE.Mesh) ?? null;
  };

  const setSelected = (mesh: THREE.Mesh | null): void => {
    if (selected) (selected.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
    selected = mesh;
    if (mesh) (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x554400);
  };

  const onMove = (event: PointerEvent): void => {
    if (stage.dataset.mode === 'fly') return; // pointer is locked mid-flight
    const mesh = pick(event);
    const node = (mesh?.userData.node as DocNode) ?? null;
    if (!tooltip) return;
    if (!node) {
      tooltip.style.visibility = 'hidden';
      stage.style.cursor = '';
      return;
    }
    tooltip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'dv-tooltip-title';
    title.textContent = node.title;
    const meta = document.createElement('div');
    meta.className = 'dv-tooltip-meta';
    meta.textContent = [node.author, node.year ? String(node.year) : null, KIND_LABELS[node.kind]]
      .filter(Boolean)
      .join(' · ');
    tooltip.append(title, meta);
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 280)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.style.visibility = 'visible';
    stage.style.cursor = 'pointer';
  };

  const onClick = (event: MouseEvent): void => {
    if (stage.dataset.mode === 'fly') return; // clicks steer the ship, not the panel
    const mesh = pick(event);
    if (!mesh) {
      setSelected(null);
      hidePanel();
      return;
    }
    setSelected(mesh);
    showPanel(mesh.userData.node as DocNode);
  };

  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('click', onClick);

  return () => {
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('click', onClick);
    if (tooltip) tooltip.style.visibility = 'hidden';
    hidePanel();
  };
}

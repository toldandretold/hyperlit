/**
 * Hover tooltip + click selection for the network scene. Raycasts against the
 * node spheres; hover fills the HTML tooltip (positioned at the cursor);
 * click SELECTS a work — its citation details land in the bottom-left panel
 * (#hn-panel), with links to open the held book / external source from there.
 * Clicking empty space (or ×) clears the selection. No instant navigation:
 * yanking the user out of a scene they're orbiting felt wrong.
 */

import * as THREE from 'three';
import type { NetworkNode } from './types';

interface InteractionDeps {
  stage: HTMLElement;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  nodeMeshes: THREE.Mesh[];
  byId: Map<string, NetworkNode>;
}

const STATUS_LABELS: Record<string, string> = {
  root: 'Root book',
  assigned: 'Harvested',
  assigned_existing: 'Harvested (already held)',
  skipped_over_budget: 'Not yet harvested (spending limit)',
  deferred: 'Found but unverified',
};

const STATUS_DOTS: Record<string, string> = {
  root: '#e0e0e0',
  assigned: '#27ae60',
  assigned_existing: '#27ae60',
  skipped_over_budget: '#f1c40f',
  deferred: '#e67e22',
};

const ARTICLE_TYPES = ['article', 'journal-article', 'journal article', 'proceedings-article', 'conference-paper', 'paper', 'incollection', 'book-chapter', 'chapter', 'book chapter'];

/** "Author, "Title"/Title, Journal|Publisher (Year)." — mirrors the report's citation style. */
function citationFragment(node: NetworkNode): DocumentFragment {
  const frag = document.createDocumentFragment();
  const append = (text: string) => frag.appendChild(document.createTextNode(text));

  append(`${node.author || 'Unknown Author'}, `);
  const isArticle = ARTICLE_TYPES.includes((node.type ?? '').toLowerCase());
  if (isArticle) {
    append(`“${node.title}”`);
  } else {
    const i = document.createElement('i');
    i.textContent = node.title;
    frag.appendChild(i);
  }
  const venue = node.journal || node.publisher;
  if (venue) append(`, ${venue}`);
  if (node.year) append(` (${node.year})`);
  append('.');
  return frag;
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function showPanel(node: NetworkNode): void {
  const panel = document.getElementById('hn-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const close = document.createElement('button');
  close.className = 'hn-panel-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => hidePanel());
  panel.appendChild(close);

  const citation = document.createElement('div');
  citation.className = 'hn-panel-citation';
  citation.appendChild(citationFragment(node));
  panel.appendChild(citation);

  const status = document.createElement('div');
  status.className = 'hn-panel-status';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = STATUS_DOTS[node.status] ?? '#e74c3c';
  status.appendChild(dot);
  const bits = [STATUS_LABELS[node.status] ?? 'Failed to harvest'];
  if (node.reason) bits.push(node.reason);
  if (node.cited_by_count) bits.push(`cited by ${fmtCount(node.cited_by_count)}`);
  status.appendChild(document.createTextNode(bits.join(' · ')));
  panel.appendChild(status);

  const links = document.createElement('div');
  links.className = 'hn-panel-links';
  if (node.book) {
    const a = document.createElement('a');
    a.href = `/${node.book}`;
    a.textContent = node.status === 'root' ? 'Open the book →' : 'Read in Hyperlit →';
    links.appendChild(a);
  }
  if (node.url) {
    const a = document.createElement('a');
    a.href = node.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'External source ↗';
    links.appendChild(a);
  }
  if (links.childElementCount) panel.appendChild(links);

  panel.hidden = false;
}

function hidePanel(): void {
  const panel = document.getElementById('hn-panel');
  if (panel) panel.hidden = true;
}

export function attachInteraction(deps: InteractionDeps): void {
  const { stage, camera, renderer, nodeMeshes } = deps;
  const tooltip = document.getElementById('hn-tooltip');
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
    if (selected) {
      (selected.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
    }
    selected = mesh;
    if (mesh) {
      (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x554400);
    }
  };

  stage.addEventListener('pointermove', (event) => {
    const mesh = pick(event);
    const node = (mesh?.userData.node as NetworkNode) ?? null;
    if (!tooltip) return;
    if (!node) {
      tooltip.style.visibility = 'hidden';
      stage.style.cursor = '';
      return;
    }
    const meta = [
      node.author,
      node.year ? String(node.year) : null,
      STATUS_LABELS[node.status] ?? 'Failed to harvest',
    ]
      .filter(Boolean)
      .join(' · ');
    tooltip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'hn-tooltip-title';
    title.textContent = node.title;
    const metaEl = document.createElement('div');
    metaEl.className = 'hn-tooltip-meta';
    metaEl.textContent = meta;
    tooltip.append(title, metaEl);
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 280)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.style.visibility = 'visible';
    stage.style.cursor = 'pointer';
  });

  stage.addEventListener('click', (event) => {
    const mesh = pick(event);
    if (!mesh) {
      setSelected(null);
      hidePanel();
      return;
    }
    setSelected(mesh);
    showPanel(mesh.userData.node as NetworkNode);
  });
}

/**
 * Homepage Drop Target
 *
 * Makes the entire home/user page a drop target for importable files.
 * - During drag: a translucent overlay shows "Drop your file to import".
 * - On drop (logged in): the import form opens with the file pre-attached and
 *   the existing change-event pipeline (validation + metadata extraction +
 *   preview) takes over.
 * - On drop (anonymous): the same overlay morphs into a login/register prompt
 *   with Close / Login / Register actions, instead of the import form opening.
 *
 * Lifecycle is managed by buttonRegistry — see registerComponents.js. The
 * registry filters this to `['home', 'user']` pages; reader pages get nothing.
 */

import { log, verbose } from '../utilities/logger.js';
import { isLoggedIn } from '../utilities/auth.js';
import { initializeUserContainer } from './userContainer.js';
import {
  attachFilesToInput,
  isAcceptableImportExt,
} from '../utilities/fileImportHelpers.js';

const OVERLAY_ID = 'page-drop-overlay';

// Module-scoped state so the registered destroyFn can clean up by reference.
let overlayEl = null;
let cardEl = null;
let dragDepth = 0;
let onDragEnter = null;
let onDragOver = null;
let onDragLeave = null;
let onDrop = null;

function isFileDrag(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

/**
 * True when the import form is already open. The form's own inline dropzone
 * handles drops onto itself — we suppress the page-level overlay in this case
 * so the two don't compete visually.
 */
function isImportFormOpen() {
  return !!document.getElementById('cite-form');
}

/* ── Overlay shell ──────────────────────────────────────────────────────── */

function buildOverlay() {
  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  // Start hidden via inline display:none. Overlay is `pointer-events: none`
  // by default so drag events pass through during a drag; we flip to `auto`
  // when showing the alert variant so its buttons receive clicks.
  el.style.cssText = [
    'position: fixed', 'inset: 0', 'z-index: 2000',
    'background: rgba(0,0,0,0.55)',
    'display: none', 'align-items: center', 'justify-content: center',
    'pointer-events: none',
    'backdrop-filter: blur(2px)',
    '-webkit-backdrop-filter: blur(2px)',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'background: #1a1a1a',
    'border: 2px dashed #EF8D34',
    'border-radius: 12px',
    'padding: 28px 36px',
    'text-align: center',
    'color: #fff',
    'box-shadow: 0 0 30px rgba(0,0,0,0.4)',
    'max-width: 90vw',
    'min-width: 280px',
  ].join(';');

  el.appendChild(card);
  cardEl = card;
  return el;
}

function renderDragMessage() {
  if (!cardEl) return;
  cardEl.innerHTML = '';
  cardEl.style.borderStyle = 'dashed';
  cardEl.style.borderColor = '#EF8D34';

  const icon = document.createElement('div');
  icon.textContent = '⤓';
  icon.style.cssText = 'font-size: 48px; line-height: 1; margin-bottom: 12px; color: #EF8D34;';

  const title = document.createElement('div');
  title.textContent = 'Drop your file to import';
  title.style.cssText = 'font-size: 20px; font-weight: 600; margin-bottom: 8px;';

  const hint = document.createElement('div');
  hint.textContent = 'PDF, EPUB, DOCX, MD, HTML or image';
  hint.style.cssText = 'font-size: 13px; opacity: 0.7;';

  cardEl.appendChild(icon);
  cardEl.appendChild(title);
  cardEl.appendChild(hint);
}

function renderAnonAlert() {
  if (!cardEl) return;
  cardEl.innerHTML = '';
  cardEl.style.borderStyle = 'solid';
  cardEl.style.borderColor = 'rgba(239,141,52,0.6)';

  const icon = document.createElement('div');
  icon.style.cssText = 'line-height: 1; margin-bottom: 10px;';
  icon.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  `;

  const title = document.createElement('div');
  title.textContent = 'Login required';
  title.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 6px;';

  const msg = document.createElement('div');
  msg.textContent = 'You need to log in or register to import a file.';
  msg.style.cssText = 'font-size: 13px; opacity: 0.85; margin-bottom: 16px;';

  const actions = document.createElement('div');
  actions.style.cssText = 'display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;';

  const styleBtn = (btn, variant) => {
    const baseCss = [
      'padding: 8px 16px',
      'border-radius: 6px',
      'font-size: 13px',
      'font-weight: 500',
      'cursor: pointer',
      'transition: opacity 0.15s ease',
      'font-family: inherit',
    ];
    if (variant === 'primary') {
      baseCss.push('background: #EF8D34', 'color: #1a1a1a', 'border: none');
    } else if (variant === 'secondary') {
      baseCss.push('background: transparent', 'color: #fff', 'border: 1px solid rgba(255,255,255,0.4)');
    } else { // close
      baseCss.push('background: transparent', 'color: #aaa', 'border: 1px solid rgba(255,255,255,0.2)');
    }
    btn.style.cssText = baseCss.join(';');
  };

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  styleBtn(closeBtn, 'close');
  closeBtn.addEventListener('click', () => hideOverlay());

  const loginBtn = document.createElement('button');
  loginBtn.type = 'button';
  loginBtn.textContent = 'Log in';
  styleBtn(loginBtn, 'primary');
  loginBtn.addEventListener('click', () => openUserContainerThenHide('login'));

  const registerBtn = document.createElement('button');
  registerBtn.type = 'button';
  registerBtn.textContent = 'Register';
  styleBtn(registerBtn, 'secondary');
  registerBtn.addEventListener('click', () => openUserContainerThenHide('register'));

  actions.appendChild(closeBtn);
  actions.appendChild(loginBtn);
  actions.appendChild(registerBtn);

  cardEl.appendChild(icon);
  cardEl.appendChild(title);
  cardEl.appendChild(msg);
  cardEl.appendChild(actions);
}

function openUserContainerThenHide(mode) {
  hideOverlay();
  const userManager = initializeUserContainer();
  if (!userManager) {
    log.error(`homepageDropTarget: user container unavailable for ${mode} prompt`, '/components/homepageDropTarget.js');
    return;
  }
  // Use show*Form() — these inject the form HTML AND open the container.
  // Calling openContainer(mode) alone opens an empty shell.
  if (mode === 'register') {
    userManager.showRegisterForm();
  } else {
    userManager.showLoginForm();
  }
}

/* ── Show / hide ────────────────────────────────────────────────────────── */

function showDragOverlay() {
  if (!overlayEl) return;
  renderDragMessage();
  overlayEl.style.display = 'flex';
  overlayEl.style.pointerEvents = 'none'; // drag passes through
}

function showAnonAlertOverlay() {
  if (!overlayEl) return;
  renderAnonAlert();
  overlayEl.style.display = 'flex';
  overlayEl.style.pointerEvents = 'auto'; // buttons receive clicks
}

function hideOverlay() {
  if (overlayEl) {
    overlayEl.style.display = 'none';
    overlayEl.style.pointerEvents = 'none';
  }
  dragDepth = 0;
}

/* ── Drop pipeline ──────────────────────────────────────────────────────── */

function waitForFileInput(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const found = document.getElementById('markdown_file');
    if (found) return resolve(found);

    const start = performance.now();
    const tick = () => {
      const el = document.getElementById('markdown_file');
      if (el) return resolve(el);
      if (performance.now() - start > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function handleAcceptedDrop(file) {
  // Gate on auth — anonymous users can't upload, so morph the overlay into
  // a login/register prompt instead of opening the import form.
  let loggedIn = false;
  try {
    loggedIn = await isLoggedIn();
  } catch (e) {
    verbose.init(`homepageDropTarget: isLoggedIn() threw — assuming anonymous (${e.message})`, '/components/homepageDropTarget.js');
  }
  if (!loggedIn) {
    showAnonAlertOverlay();
    return;
  }

  // Logged-in path: open the import form by clicking the Import button.
  const importBtn = document.getElementById('importBook');
  if (importBtn) {
    importBtn.click();
  } else {
    verbose.init('homepageDropTarget: #importBook not present — cannot open form', '/components/homepageDropTarget.js');
    return;
  }

  const fileInput = await waitForFileInput();
  if (!fileInput) {
    log.error('homepageDropTarget: #markdown_file did not appear in time', '/components/homepageDropTarget.js');
    return;
  }
  attachFilesToInput(fileInput, [file]);
  verbose.init(`homepageDropTarget: attached "${file.name}" (${file.size} bytes) to import form`, '/components/homepageDropTarget.js');
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

export function initializeHomepageDropTarget() {
  if (overlayEl) return; // idempotent

  overlayEl = buildOverlay();
  document.body.appendChild(overlayEl);

  onDragEnter = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    // Form already open → defer to its inline dropzone, no page-level overlay.
    if (isImportFormOpen()) return;
    // If the alert is currently shown, ignore drag enters — the user needs
    // to dismiss the alert first.
    if (overlayEl && overlayEl.style.pointerEvents === 'auto') return;
    dragDepth++;
    if (dragDepth === 1) showDragOverlay();
  };

  onDragOver = (e) => {
    if (!isFileDrag(e)) return;
    // MUST preventDefault on every dragover or the browser navigates to
    // the dropped file when it lands outside any drop handler — even when
    // the form is open and we're not showing our own overlay.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  onDragLeave = (e) => {
    if (!isFileDrag(e)) return;
    if (isImportFormOpen()) return;
    if (overlayEl && overlayEl.style.pointerEvents === 'auto') return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  };

  onDrop = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    // Reset drag depth — drop ends the drag sequence.
    dragDepth = 0;
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    if (!files.length) {
      hideOverlay();
      return;
    }
    const file = files[0];
    if (!isAcceptableImportExt(file)) {
      verbose.init(`homepageDropTarget: rejected drop "${file.name}" — extension not in allowlist`, '/components/homepageDropTarget.js');
      hideOverlay();
      return;
    }
    // Form already open: skip the overlay/auth dance entirely. Either the drop
    // landed on the inline dropzone (it has stopPropagation, so this handler
    // never runs) or it landed on empty page area — in which case attach the
    // file directly to the existing input. The form's own submit-time auth
    // gate covers anonymous users.
    if (isImportFormOpen()) {
      const fileInput = document.getElementById('markdown_file');
      if (fileInput) attachFilesToInput(fileInput, [file]);
      return;
    }
    // Hand off to async handler. If anon, it'll re-show the overlay as alert;
    // if logged in, it hides the overlay and opens the form.
    hideOverlay();
    handleAcceptedDrop(file);
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  log.init('Homepage drop target initialized', '/components/homepageDropTarget.js');
}

export function destroyHomepageDropTarget() {
  if (onDragEnter) window.removeEventListener('dragenter', onDragEnter);
  if (onDragOver) window.removeEventListener('dragover', onDragOver);
  if (onDragLeave) window.removeEventListener('dragleave', onDragLeave);
  if (onDrop) window.removeEventListener('drop', onDrop);

  onDragEnter = null;
  onDragOver = null;
  onDragLeave = null;
  onDrop = null;

  if (overlayEl && overlayEl.parentNode) {
    overlayEl.parentNode.removeChild(overlayEl);
  }
  overlayEl = null;
  cardEl = null;
  dragDepth = 0;
}

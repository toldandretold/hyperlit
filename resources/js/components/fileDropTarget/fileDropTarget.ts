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
 * Lifecycle is managed by buttonRegistry — see registerComponents.ts. The
 * registry filters this to `['home', 'user']` pages; reader pages get nothing.
 */

import { log, verbose } from '../../utilities/logger';
import { isLoggedIn } from '../../utilities/auth/index';
import { initializeUserContainer } from '../userButton/userButton';
import { attachFilesToInput } from '../utilities/fileImportHelpers';
import {
  buildIngestPlan,
  captureDropEntries,
  collectEntries,
  planAsBatch,
  type CollectedFile,
  type IngestPlan,
} from '../importQueue/folderIngest';
import { uploadBatch } from '../importQueue/batchUploader';
import { showImportQueuePreparing, clearImportQueuePreparing } from '../importQueue/importQueue';

const OVERLAY_ID = 'page-drop-overlay';

// Module-scoped state so the registered destroyFn can clean up by reference.
let overlayEl: any = null;
let cardEl: any = null;
let dragDepth = 0;
let onDragEnter: any = null;
let onDragOver: any = null;
let onDragLeave: any = null;
let onDrop: any = null;

function isFileDrag(e: any) {
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

  const styleBtn = (btn: any, variant: any) => {
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

/** Info/error card in the drop overlay with a Close button (clickable). */
function renderBatchMessage(title: string, detail: string, autoHideMs: number | null) {
  if (!cardEl) return;
  cardEl.innerHTML = '';
  cardEl.style.borderStyle = 'solid';
  cardEl.style.borderColor = 'rgba(239,141,52,0.6)';

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 6px;';

  const msg = document.createElement('div');
  msg.textContent = detail;
  msg.style.cssText = 'font-size: 13px; opacity: 0.85; margin-bottom: 16px;';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; background: transparent; color: #aaa; border: 1px solid rgba(255,255,255,0.2); font-family: inherit;';
  closeBtn.addEventListener('click', () => hideOverlay());

  cardEl.appendChild(titleEl);
  cardEl.appendChild(msg);
  cardEl.appendChild(closeBtn);

  if (overlayEl) {
    overlayEl.style.display = 'flex';
    overlayEl.style.pointerEvents = 'auto';
  }
  if (autoHideMs) {
    setTimeout(() => {
      // Only auto-hide if this card is still the one showing.
      if (cardEl && cardEl.contains(closeBtn)) hideOverlay();
    }, autoHideMs);
  }
}

function showBatchStartedOverlay(count: number) {
  renderBatchMessage(
    `Importing ${count} text${count === 1 ? '' : 's'}…`,
    count === 1
      ? 'Queued — track progress in the corner panel.'
      : 'Track progress in the corner panel. Books land on a shelf as they finish.',
    4000,
  );
}

function showBatchMessageOverlay(title: string, detail: string) {
  renderBatchMessage(title, detail, null);
}

function openUserContainerThenHide(mode: any) {
  hideOverlay();
  const userManager = initializeUserContainer();
  if (!userManager) {
    log.error(`fileDropTarget: user container unavailable for ${mode} prompt`, '/components/fileDropTarget/fileDropTarget.ts');
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

async function checkLoggedInOrPrompt(): Promise<boolean> {
  // Gate on auth — anonymous users can't upload, so morph the overlay into
  // a login/register prompt instead of proceeding.
  let loggedIn = false;
  try {
    loggedIn = await isLoggedIn();
  } catch (e) {
    verbose.init(`fileDropTarget: isLoggedIn() threw — assuming anonymous (${(e as any).message})`, '/components/fileDropTarget/fileDropTarget.ts');
  }
  if (!loggedIn) showAnonAlertOverlay();
  return loggedIn;
}

async function handleAcceptedDrop(files: File[]) {
  if (!(await checkLoggedInOrPrompt())) return;

  // Logged-in path: open the import form by clicking the Import button.
  const importBtn = document.getElementById('importBook');
  if (importBtn) {
    importBtn.click();
  } else {
    verbose.init('fileDropTarget: #importBook not present — cannot open form', '/components/fileDropTarget/fileDropTarget.ts');
    return;
  }

  const fileInput = await waitForFileInput();
  if (!fileInput) {
    log.error('fileDropTarget: #markdown_file did not appear in time', '/components/fileDropTarget/fileDropTarget.ts');
    return;
  }
  attachFilesToInput(fileInput, files);
  verbose.init(`fileDropTarget: attached ${files.length} file(s) to import form`, '/components/fileDropTarget/fileDropTarget.ts');
}

/**
 * Multi-book drop (folder of PDFs / an Obsidian vault): register a batch and
 * upload sequentially — the corner import-queue widget is the progress UI.
 */
async function handleBatchDrop(plan: IngestPlan) {
  if (!(await checkLoggedInOrPrompt())) return;

  // Multi-book drops get an auto-shelf (folder name, or a dated label for
  // loose files). A batch of ONE (a file queued behind a running import)
  // gets no shelf — one book is not a collection.
  const single = plan.bundles.length === 1 ? plan.bundles[0] : null;
  const label = plan.folderName
    || (single ? single.title : `Import ${new Date().toISOString().slice(0, 10)}`);

  // Show the queue widget IMMEDIATELY, panel expanded — the progress plays
  // out in place. Pages without the widget (journal) fall back to the
  // drop-overlay info card.
  if (!showImportQueuePreparing(plan.bundles.length)) {
    showBatchStartedOverlay(plan.bundles.length);
  }

  try {
    const result = await uploadBatch(plan.bundles, {
      label,
      source: plan.source,
      autoShelf: plan.bundles.length > 1,
      manifest: plan.manifest,
    });
    verbose.content(`fileDropTarget: batch ${result.batchId} — ${result.uploaded} uploaded, ${result.failed} failed`, '/components/fileDropTarget/fileDropTarget.ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('fileDropTarget: batch import failed to start', '/components/fileDropTarget/fileDropTarget.ts', message);
    clearImportQueuePreparing();
    showBatchMessageOverlay('Could not start the batch import', message);
  }
}

/** Route a completed drop by what it contains. */
async function routeDrop(entries: ReturnType<typeof captureDropEntries>, plainFiles: File[]) {
  let collected: CollectedFile[];
  let rootDirName: string | null = null;

  if (entries) {
    const res = await collectEntries(entries);
    collected = res.files;
    rootDirName = res.rootDirName;
    // Entries API present but yielded nothing (rare) — fall back to files.
    if (!collected.length && plainFiles.length) {
      collected = plainFiles.map((f) => ({ file: f, relPath: f.name }));
    }
  } else {
    // No entries API: a real folder yields an empty FileList here.
    if (!plainFiles.length) {
      showBatchMessageOverlay(
        'Folder drop is not supported in this browser',
        'Use the Import form’s file picker instead.',
      );
      return;
    }
    collected = plainFiles.map((f) => ({ file: f, relPath: f.name }));
  }

  let plan = await buildIngestPlan(collected, rootDirName);

  if (plan.kind === 'none') {
    verbose.init('fileDropTarget: rejected drop — nothing importable', '/components/fileDropTarget/fileDropTarget.ts');
    showBatchMessageOverlay('Nothing importable in that drop', 'PDF, EPUB, DOCX, MD, HTML or image files.');
    return;
  }

  // Form already open: single-book shapes attach to the existing input (its
  // change pipeline takes over); multi-book shapes go straight to the batch.
  if (isImportFormOpen() && plan.kind !== 'batch') {
    const fileInput = document.getElementById('markdown_file');
    if (fileInput) {
      attachFilesToInput(fileInput, plan.files);
      return;
    }
    // #cite-form exists but its input is gone — an import is RUNNING and its
    // progress card has replaced the form's children. This drop used to be a
    // silent no-op; queue it as a batch instead, so the widget shows it
    // waiting behind the running import (the queue grows as you add).
    plan = planAsBatch(plan);
    if (plan.kind !== 'batch') return;
  }

  if (plan.kind === 'single' || plan.kind === 'one-book-folder') {
    await handleAcceptedDrop(plan.files);
    return;
  }

  await handleBatchDrop(plan);
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

export function initializeFileDropTarget() {
  if (overlayEl) return; // idempotent

  overlayEl = buildOverlay();
  document.body.appendChild(overlayEl);

  onDragEnter = (e: any) => {
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

  onDragOver = (e: any) => {
    if (!isFileDrag(e)) return;
    // MUST preventDefault on every dragover or the browser navigates to
    // the dropped file when it lands outside any drop handler — even when
    // the form is open and we're not showing our own overlay.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  onDragLeave = (e: any) => {
    if (!isFileDrag(e)) return;
    if (isImportFormOpen()) return;
    if (overlayEl && overlayEl.style.pointerEvents === 'auto') return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  };

  onDrop = (e: any) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    // Reset drag depth — drop ends the drag sequence.
    dragDepth = 0;

    // Capture directory entries SYNCHRONOUSLY — webkitGetAsEntry() results
    // are invalidated the moment this handler yields, so this cannot happen
    // inside the async router.
    const entries = e.dataTransfer ? captureDropEntries(e.dataTransfer) : null;
    const plainFiles: File[] = Array.from((e.dataTransfer && e.dataTransfer.files) || []);

    if (!entries && !plainFiles.length) {
      hideOverlay();
      return;
    }

    // Hand off to the async router: single file → existing form flow;
    // one md + images → the one-book folder path; folder of docs / an
    // Obsidian vault → batch import with the corner widget as UI. If anon,
    // the router re-shows the overlay as a login alert.
    hideOverlay();
    void routeDrop(entries, plainFiles);
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  verbose.init('File drop target initialized', '/components/fileDropTarget/fileDropTarget.ts');
}

export function destroyFileDropTarget() {
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

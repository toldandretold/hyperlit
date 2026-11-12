/**
 * Dropping a file while the viewer's OWN shelf is open imports onto that shelf.
 *
 * shelfHeader stamps #shelf-header[data-drop-shelf-id] for owner + ordinary
 * ('user'-kind) shelves only; fileDropTarget then routes EVERY importable drop
 * (a single file included) through the batch lane with that shelf_id, instead
 * of opening the import form / minting an auto-shelf. Server half:
 * ImportBatchController::store authorizes the shelf_id (ImportBatchTest.php).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ingest = vi.hoisted(() => ({
  captureDropEntries: vi.fn(() => null),
  collectEntries: vi.fn(async () => ({ files: [], rootDirName: null })),
  buildIngestPlan: vi.fn(),
  planAsBatch: vi.fn(),
}));
const uploader = vi.hoisted(() => ({ uploadBatch: vi.fn(async () => ({ batchId: '1', uploaded: 1, failed: 0 })) }));

vi.mock('../../../resources/js/components/importQueue/folderIngest', () => ingest);
vi.mock('../../../resources/js/components/importQueue/batchUploader', () => uploader);
vi.mock('../../../resources/js/components/importQueue/importQueue', () => ({
  showImportQueuePreparing: vi.fn(() => true),
  clearImportQueuePreparing: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({ isLoggedIn: vi.fn(async () => true) }));
vi.mock('../../../resources/js/components/userButton/userButton', () => ({ initializeUserContainer: vi.fn() }));

import {
  initializeFileDropTarget,
  destroyFileDropTarget,
  openOwnedShelf,
} from '../../../resources/js/components/fileDropTarget/fileDropTarget';
import { showShelfHeader, removeShelfHeader } from '../../../resources/js/components/shelves/shelfHeader';

const SHELF = '11111111-2222-4333-8444-555555555555';
const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
const bundle = { mainFile: file, images: [], rewrittenMain: null, title: 'notes', filename: 'notes.md', metadata: null };
const single = { kind: 'single', files: [file], bundles: [], folderName: null, source: 'files', manifest: null };
const asBatch = { ...single, kind: 'batch', files: [], bundles: [bundle] };

function drop() {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  e.dataTransfer = { types: ['Files'], files: [file] };
  window.dispatchEvent(e);
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function header(attrs = {}) {
  const h = document.createElement('div');
  h.id = 'shelf-header';
  Object.assign(h.dataset, attrs);
  document.body.appendChild(h);
}

describe('drop onto your own open shelf', () => {
  let importClicks;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<button id="importBook"></button>';
    importClicks = 0;
    document.getElementById('importBook').addEventListener('click', () => { importClicks++; });
    ingest.buildIngestPlan.mockResolvedValue(single);
    ingest.planAsBatch.mockReturnValue(asBatch);
    initializeFileDropTarget();
  });

  afterEach(() => destroyFileDropTarget());

  it('a single file goes onto the shelf via the batch lane, not the import form', async () => {
    header({ dropShelfId: SHELF, dropShelfName: 'Cyber Politics' });
    expect(openOwnedShelf()).toEqual({ id: SHELF, name: 'Cyber Politics' });

    drop();
    await flush();

    expect(uploader.uploadBatch).toHaveBeenCalledTimes(1);
    const [bundles, opts] = uploader.uploadBatch.mock.calls[0];
    expect(bundles).toEqual([bundle]);
    expect(opts.shelfId).toBe(SHELF);
    expect(opts.autoShelf).toBe(false);
    expect(importClicks).toBe(0);
  });

  it('with no owned shelf open, a single file still opens the import form', async () => {
    header({}); // a visitor's / system shelf header: no drop stamp
    expect(openOwnedShelf()).toBeNull();

    drop();
    await flush();

    expect(uploader.uploadBatch).not.toHaveBeenCalled();
    expect(importClicks).toBe(1);
  });

  it('the drag overlay names the shelf', () => {
    header({ dropShelfId: SHELF, dropShelfName: 'Cyber Politics' });
    const e = new Event('dragenter', { bubbles: true, cancelable: true });
    e.dataTransfer = { types: ['Files'] };
    window.dispatchEvent(e);
    expect(document.getElementById('page-drop-overlay').textContent).toContain('Cyber Politics');
  });
});

describe('shelfHeader stamps the drop target only for the owner\'s ordinary shelf', () => {
  const base = { shelfId: SHELF, shelfName: 'Cyber Politics', visibility: 'public', currentSort: 'recent', isSystemShelf: false, username: 'sam', slug: 'cyber-politics' };
  const mount = (opts) => {
    document.body.innerHTML = '<div class="home-content-wrapper"><div class="fixed-header"></div><div class="main-content"></div></div>';
    showShelfHeader({ ...base, ...opts });
    return document.getElementById('shelf-header');
  };

  afterEach(() => removeShelfHeader());

  it('owner + user kind → stamped', () => {
    expect(mount({ isOwner: true, kind: 'user' })?.dataset.dropShelfId).toBe(SHELF);
  });
  it('visitor → not stamped', () => {
    expect(mount({ isOwner: false, kind: 'user' })?.dataset.dropShelfId).toBeUndefined();
  });
  it('Likes / licence-review / system shelves → not stamped', () => {
    expect(mount({ isOwner: true, kind: 'likes' })?.dataset.dropShelfId).toBeUndefined();
    expect(mount({ isOwner: true, kind: 'licence_review' })?.dataset.dropShelfId).toBeUndefined();
    expect(mount({ isOwner: true, kind: 'user', isSystemShelf: true, shelfId: null })?.dataset.dropShelfId).toBeUndefined();
  });
});

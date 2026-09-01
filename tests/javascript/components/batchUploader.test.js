// Batch uploader wire format: what actually goes over the fetch boundary.
// Pins:
//  - the register POST carries shelf_id when opts.shelfId is set (the
//    maintainer shelf-import drop target) and omits it otherwise;
//  - per-file FormData carries ONLY whitelisted manifest metadata plus the
//    scrape-folder provenance breadcrumbs (imported_via / schema version /
//    site) — unknown manifest keys never reach the server;
//  - manifest metadata feeds the book-id slug (author+year+title shape).

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { uploadBatch } from '../../../resources/js/components/importQueue/batchUploader';

const pdfFile = (name) => new File(['fakepdf'], name, { type: 'application/pdf' });

const bundle = (overrides = {}) => ({
  mainFile: pdfFile('doc.pdf'),
  images: [],
  rewrittenMain: null,
  title: 'Doc',
  filename: 'doc.pdf',
  metadata: null,
  ...overrides,
});

/** Route the uploader's three endpoints; record every call. */
function mockFetch() {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === '/api/validate-book-id') {
      return new Response(JSON.stringify({ success: true, exists: false }), { status: 200 });
    }
    if (String(url) === '/api/import-batches') {
      return new Response(JSON.stringify({ id: 'batch-1', shelf: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
});

describe('uploadBatch wire format', () => {
  test('register POST carries shelf_id when set, omits it otherwise', async () => {
    let calls = mockFetch();
    await uploadBatch([bundle()], { label: 'L', source: 'files', autoShelf: false, shelfId: 'shelf-uuid-1' });
    let register = calls.find((c) => c.url === '/api/import-batches');
    expect(JSON.parse(register.init.body)).toMatchObject({ shelf_id: 'shelf-uuid-1', auto_shelf: false });

    calls = mockFetch();
    await uploadBatch([bundle()], { label: 'L', source: 'files', autoShelf: true });
    register = calls.find((c) => c.url === '/api/import-batches');
    expect(JSON.parse(register.init.body)).not.toHaveProperty('shelf_id');
  });

  test('manifest metadata rides the file POST via the whitelist, with provenance breadcrumbs', async () => {
    const calls = mockFetch();
    await uploadBatch([bundle({
      title: 'Belgrade Declaration',
      metadata: {
        author: 'NAM', year: 1961, url: 'https://ris.org.in/x.pdf', language: 'en',
        // A rogue key on the object (bypassing folderIngest's parse-time
        // strip) must still never reach the server.
        evil_key: 'nope',
      },
    })], { label: 'L', source: 'folder', autoShelf: false, manifest: { schemaVersion: 1, site: 'ris.org.in' } });

    const upload = calls.find((c) => c.url === '/import-file');
    const fd = upload.init.body;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('title')).toBe('Belgrade Declaration');
    expect(fd.get('author')).toBe('NAM');
    expect(fd.get('year')).toBe('1961');
    expect(fd.get('url')).toBe('https://ris.org.in/x.pdf');
    expect(fd.get('language')).toBe('en');
    expect(fd.get('imported_via')).toBe('scrape-folder');
    expect(fd.get('manifest_schema_version')).toBe('1');
    expect(fd.get('scrape_site')).toBe('ris.org.in');
    expect(fd.has('evil_key')).toBe(false);
  });

  test('no metadata, no manifest: the file POST stays minimal', async () => {
    const calls = mockFetch();
    await uploadBatch([bundle()], { label: 'L', source: 'files', autoShelf: false });
    const upload = calls.find((c) => c.url === '/import-file');
    const fd = upload.init.body;
    expect(fd.has('imported_via')).toBe(false);
    expect(fd.has('author')).toBe(false);
    expect(fd.get('book')).toBeTruthy();
    expect(fd.get('import_batch_id')).toBe('batch-1');
  });

  test('manifest author/year shape the book id slug', async () => {
    const calls = mockFetch();
    await uploadBatch([bundle({
      title: 'Belgrade Declaration',
      metadata: { author: 'Tito, Josip', year: 1961 },
    })], { label: 'L', source: 'folder', autoShelf: false });

    const upload = calls.find((c) => c.url === '/import-file');
    expect(upload.init.body.get('book')).toMatch(/^tito1961belgrade/);
  });
});

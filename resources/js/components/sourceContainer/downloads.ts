// Download / export pipeline for the source container: Markdown (+image zip),
// DOCX (styled, with footnotes/tables/images), EPUB, and the "download all"
// raw bundle. Standalone functions wired to the #download-* buttons by
// sourceContainer/index.ts. Lazy-loads the heavy converters (Turndown, JSZip,
// docx, html-to-text) from the CDN on first use.
import { book } from '../../app.js';
import { openDatabase, getNodeChunksFromIndexedDB } from '../../indexedDB/index';
import { formatBibtexToCitation } from '../../utilities/bibtexProcessor.js';
import { getRecord, getBookDownloadName } from './helpers';

let _TurndownService: any = null;
async function loadTurndown() {
  if (_TurndownService) return _TurndownService;
  // Skypack will auto-optimize to an ES module
  const mod = await import('https://cdn.skypack.dev/turndown');
  // turndown's default export is the constructor
  _TurndownService = mod.default;
  return _TurndownService;
}

let _TurndownGfm: any = null;
async function loadTurndownGfm() {
  if (_TurndownGfm) return _TurndownGfm;
  const mod = await import('https://cdn.skypack.dev/turndown-plugin-gfm');
  _TurndownGfm = mod;
  return _TurndownGfm;
}

let _JSZip: any = null;
async function loadJSZip() {
  if (_JSZip) return _JSZip;
  const mod = await import('https://cdn.skypack.dev/jszip');
  _JSZip = mod.default;
  return _JSZip;
}

let _Docx: any = null;
async function loadDocxLib() {
  if (_Docx) return _Docx;
  // Skypack serves this as a proper ES module with CORS headers
  const mod = await import('https://cdn.skypack.dev/docx@8.3.0');
  // The module exports Document, Packer, Paragraph, etc.
  _Docx = mod;
  return _Docx;
}

let _htmlToText: any = null;
async function loadHtmlToText() {
  if (_htmlToText) return _htmlToText;
  const mod = await import('https://cdn.skypack.dev/html-to-text');
  _htmlToText = mod.htmlToText;
  return _htmlToText;
}

/**
 * Converts citation HTML (from formatBibtexToCitation) to inline markdown.
 * <i>text</i> → *text*, <a href="url">text</a> → [text](url), strips other tags.
 */
function citationHtmlToMarkdown(html: any): string {
  return html
    .replace(/<i>([^<]*)<\/i>/g, '*$1*')
    .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/g, '[$2]($1)')
    .replace(/<[^>]+>/g, '');
}

/**
 * The inline handler behind the #download-all button: fetches the server "raw"
 * zip and augments it with the client-side blackBox snapshot (browser / IDB /
 * server / stitched markdown + README). Falls back to a client-only zip if the
 * server fetch fails. Restores the button label when done.
 */
export async function downloadAllForBook(downloadAllBtn: any, bookId: any = book) {
  const origText = downloadAllBtn.textContent;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Preparing download…';

  const triggerBlobDownload = (blob: any, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  try {
    // Step 1: Fetch server zip — this is the critical part
    const zipResp = await fetch(`/${encodeURIComponent(bookId)}/download-all`, { credentials: 'include' });
    if (!zipResp.ok) throw new Error(`Server zip fetch failed (${zipResp.status})`);
    const serverZipBlob = await zipResp.blob();

    // Step 2: Try to augment with blackBox (non-critical — failures just skip it)
    try {
      const [{ buildBrowserMd, buildBrowserDatabaseMd, buildServerDatabaseMd, buildStitchedUpMd, buildReadme, buildTopLevelReadme }, JSZip] =
        await Promise.all([
          import('../../integrity/emergencyBackup.js'),
          loadJSZip(),
        ]);

      const [browserResult, idbResult, serverMd] = await Promise.all([
        buildBrowserMd(bookId),
        buildBrowserDatabaseMd(bookId),
        buildServerDatabaseMd(bookId),
      ]);

      const zip = await JSZip.loadAsync(serverZipBlob);

      const stitchedMd = buildStitchedUpMd(
        idbResult?.nodeMap || null,
        browserResult?.nodeMap || null,
      );

      const bbFiles: any = {};
      if (browserResult?.markdown) bbFiles['browser.md'] = browserResult.markdown;
      if (idbResult?.markdown) bbFiles['browserDatabase.md'] = idbResult.markdown;
      if (serverMd) bbFiles['serverDatabase.md'] = serverMd;
      if (stitchedMd) bbFiles['stitchedUp.md'] = stitchedMd;
      bbFiles['README.md'] = buildReadme(bookId, bbFiles);

      const prefix = `${bookId}/blackBox`;
      for (const [name, content] of Object.entries(bbFiles)) {
        zip.file(`${prefix}/${name}`, content);
      }

      zip.file(`${bookId}/README.md`, buildTopLevelReadme(bookId, zip));

      const augmented = await zip.generateAsync({ type: 'blob' });
      triggerBlobDownload(augmented, `${bookId}.zip`);
    } catch (augmentErr) {
      console.warn('[sourceButton] BlackBox augmentation failed, downloading plain zip:', augmentErr);
      triggerBlobDownload(serverZipBlob, `${bookId}.zip`);
    }
  } catch (err) {
    // Server zip fetch failed (404, network error) — build client-only blackBox zip
    console.warn('[sourceButton] Server zip fetch failed, building client-only zip:', err);
    try {
      const [{ buildBrowserMd, buildBrowserDatabaseMd, buildServerDatabaseMd, buildStitchedUpMd, buildReadme, buildTopLevelReadme }, JSZip] =
        await Promise.all([
          import('../../integrity/emergencyBackup.js'),
          loadJSZip(),
        ]);

      const [browserResult, idbResult, serverMd] = await Promise.all([
        buildBrowserMd(bookId),
        buildBrowserDatabaseMd(bookId),
        buildServerDatabaseMd(bookId),
      ]);

      const zip = new JSZip();
      const stitchedMd = buildStitchedUpMd(
        idbResult?.nodeMap || null,
        browserResult?.nodeMap || null,
      );

      const bbFiles: any = {};
      if (browserResult?.markdown) bbFiles['browser.md'] = browserResult.markdown;
      if (idbResult?.markdown) bbFiles['browserDatabase.md'] = idbResult.markdown;
      if (serverMd) bbFiles['serverDatabase.md'] = serverMd;
      if (stitchedMd) bbFiles['stitchedUp.md'] = stitchedMd;
      bbFiles['README.md'] = buildReadme(bookId, bbFiles);

      const prefix = `${bookId}/blackBox`;
      for (const [name, content] of Object.entries(bbFiles)) {
        zip.file(`${prefix}/${name}`, content);
      }

      zip.file(`${bookId}/README.md`, buildTopLevelReadme(bookId, zip));

      const blob = await zip.generateAsync({ type: 'blob' });
      triggerBlobDownload(blob, `${bookId}.zip`);
    } catch (fallbackErr) {
      console.error('[sourceButton] Client-only zip also failed:', fallbackErr);
      downloadAllBtn.textContent = 'Download failed';
      setTimeout(() => { downloadAllBtn.textContent = origText; }, 3000);
    }
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = origText;
  }
}

/**
 * Fetches all nodes for a book, converts to markdown,
 * and returns { markdown, images }.
 */
async function buildMarkdownForBook(bookId: any = book || 'latest'): Promise<{ markdown: string; images: any[] }> {
  // Ensure all chunks are available before exporting
  if ((window as any)._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../pageLoad');
    await waitForBackgroundDownload();
  }
  const chunks: any = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a: any, b: any) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();

  // --- Phase 1: Parse all chunks into DOM fragments ---
  const fragments: any[] = [];
  for (const chunk of chunks) {
    const frag: any = parser.parseFromString(
      `<div>${chunk.content || chunk.html}</div>`,
      'text/html'
    ).body.firstChild;
    fragments.push(frag);
  }

  // --- Phase 2: Pre-scan for footnote refs, hypercite arrows, citation refs, images ---
  const footnoteRefIds: any[] = [];
  const hyperciteArrows: any[] = [];
  const citationRefIds: any[] = [];
  const imageUrls = new Set<string>();
  const seenFnIds = new Set<string>();

  for (const frag of fragments) {
    frag.querySelectorAll('sup.footnote-ref[id]').forEach((sup: any) => {
      if (!seenFnIds.has(sup.id)) {
        seenFnIds.add(sup.id);
        footnoteRefIds.push(sup.id);
      }
    });

    frag.querySelectorAll('a.citation-ref[id]').forEach((cite: any) => {
      citationRefIds.push(cite.id);
    });

    frag.querySelectorAll('a[href]').forEach((anchor: any) => {
      if ((anchor.classList.contains('open-icon') || anchor.querySelector('sup.open-icon')) && anchor.id && !seenFnIds.has(anchor.id)) {
        seenFnIds.add(anchor.id);
        try {
          const href = anchor.getAttribute('href');
          const parsed = new URL(href, window.location.origin);
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length > 0) {
            let sourceUrl = parsed.origin + parsed.pathname;
            if (parsed.hash) {
              sourceUrl += parsed.hash;
            }
            hyperciteArrows.push({ id: anchor.id, targetBookId: decodeURIComponent(segments[0]!), sourceUrl });
          }
        } catch (e) {
          console.warn('Failed to parse hypercite href:', anchor.getAttribute('href'), e);
        }
      }
    });

    frag.querySelectorAll('img[src]').forEach((img: any) => {
      imageUrls.add(img.getAttribute('src'));
    });
  }

  // --- Phase 3: Fetch footnote content from IndexedDB ---
  const footnoteContents = new Map<string, string[]>(); // fnId → markdown string
  let fnDb: any;
  if (footnoteRefIds.length > 0) {
    try { fnDb = await openDatabase(); } catch (e) { console.warn('Failed to open DB for footnotes:', e); }
  }

  // Helper: convert footnote HTML nodes to markdown text
  const Turndown = await loadTurndown();
  const simpleTd = new Turndown({ headingStyle: 'atx' });

  for (const fnId of footnoteRefIds) {
    const subBookId = `${bookId}/${fnId}`;
    try {
      let fnNodes: any = await getNodeChunksFromIndexedDB(subBookId);

      if ((!fnNodes || fnNodes.length === 0) && fnDb) {
        try {
          const tx = fnDb.transaction('footnotes', 'readonly');
          const index = tx.objectStore('footnotes').index('footnoteId');
          const results: any[] = await new Promise((resolve, reject) => {
            const req = index.getAll(fnId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          const fnRecord = results.find((r: any) => r.book === bookId);
          if (fnRecord?.preview_nodes?.length) {
            fnNodes = fnRecord.preview_nodes;
          }
        } catch (e) {
          console.warn(`Failed to look up footnotes store for ${fnId}:`, e);
        }
      }

      if (fnNodes) fnNodes.sort((a: any, b: any) => a.chunk_id - b.chunk_id);
      const paragraphs: string[] = [];
      for (const node of (fnNodes || [])) {
        const content = node.content || node.html || '';
        if (content.trim()) {
          paragraphs.push(simpleTd.turndown(content).trim());
        }
      }
      footnoteContents.set(fnId, paragraphs.length > 0 ? paragraphs : ['(footnote)']);
    } catch (e) {
      console.warn(`Failed to fetch footnote content for ${fnId}:`, e);
      footnoteContents.set(fnId, ['(footnote)']);
    }
  }

  // --- Phase 4: Fetch citation data for hypercite arrows ---
  const hyperciteContents = new Map<string, string>(); // elementId → markdown citation string
  let db: any;
  if (hyperciteArrows.length > 0) {
    try { db = await openDatabase(); } catch (e) { console.warn('Failed to open database for hypercite citations:', e); }
  }

  for (const { id, targetBookId, sourceUrl } of hyperciteArrows) {
    let citationMd = targetBookId;
    try {
      if (db) {
        const record = await getRecord(db, 'library', targetBookId);
        if (record?.bibtex) {
          let citationHtml: any = await formatBibtexToCitation(record.bibtex);
          if (sourceUrl) {
            if (citationHtml.includes('<a ')) {
              citationHtml = citationHtml.replace(/(<a\s[^>]*href=")([^"]*)(")/, `$1${sourceUrl}$3`);
            } else {
              const titleMatch = citationHtml.match(/(<i>[^<]+<\/i>|"[^"]+")/);
              if (titleMatch) {
                citationHtml = citationHtml.replace(titleMatch[0], `<a href="${sourceUrl}">${titleMatch[0]}</a>`);
              } else {
                citationHtml = `<a href="${sourceUrl}">${citationHtml}</a>`;
              }
            }
          }
          citationMd = citationHtmlToMarkdown(citationHtml);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch citation for ${targetBookId}:`, e);
    }
    hyperciteContents.set(id, citationMd);
  }

  // --- Phase 4b: Fetch bibliography records for citation refs ---
  const referencesData: any[] = [];
  if (citationRefIds.length > 0) {
    let bibDb: any;
    try { bibDb = db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for bibliography:', e); }
    if (bibDb) {
      const seenSourceIds = new Set<any>();
      for (const refId of citationRefIds) {
        try {
          const tx = bibDb.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const record: any = await new Promise((resolve, reject) => {
            const req = store.get([bookId, refId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          // Dedup key: prefer canonical_source_id (true citation identity) over
          // source_id (the specific version). Without this, multiple citations
          // pointing to the same canonical-only work would all collapse on a
          // shared null source_id.
          const dedupKey = record?.canonical_source_id || record?.source_id || null;
          if (record?.content && !seenSourceIds.has(dedupKey)) {
            seenSourceIds.add(dedupKey);
            referencesData.push({ content: record.content });
          }
        } catch (e) {
          console.warn(`Failed to fetch bibliography record for ${refId}:`, e);
        }
      }
    }
  }

  // --- Phase 5: Configure Turndown with GFM tables and custom rules ---
  const turndownService = new Turndown({ headingStyle: 'atx' });

  // Apply GFM tables plugin
  try {
    const gfm = await loadTurndownGfm();
    if (gfm.tables) {
      turndownService.use(gfm.tables);
    }
  } catch (e) {
    console.warn('Failed to load GFM tables plugin:', e);
  }

  // Unified footnote numbering: footnotes and hypercites share one sequence
  let footnoteCounter = 0;
  const footnoteLabels = new Map<string, number>(); // elementId → number

  // Custom rule: footnote references
  turndownService.addRule('footnote-ref', {
    filter: (node: any) => {
      return node.nodeName === 'SUP'
        && node.classList?.contains('footnote-ref')
        && node.id
        && footnoteContents.has(node.id);
    },
    replacement: (content: any, node: any) => {
      if (!footnoteLabels.has(node.id)) {
        footnoteLabels.set(node.id, ++footnoteCounter);
      }
      return `[^${footnoteLabels.get(node.id)}]`;
    }
  });

  // Custom rule: hypercite arrows
  turndownService.addRule('hypercite-arrow', {
    filter: (node: any) => {
      return node.nodeName === 'A'
        && (node.classList?.contains('open-icon') || node.querySelector?.('sup.open-icon'))
        && node.id
        && hyperciteContents.has(node.id);
    },
    replacement: (content: any, node: any) => {
      if (!footnoteLabels.has(node.id)) {
        footnoteLabels.set(node.id, ++footnoteCounter);
      }
      return `[^${footnoteLabels.get(node.id)}]`;
    }
  });

  // Custom rule: citation refs → plain text
  turndownService.addRule('citation-ref', {
    filter: (node: any) => {
      return node.nodeName === 'A' && node.classList?.contains('citation-ref');
    },
    replacement: (content: any) => content
  });

  // Image filename tracking for deduplication
  const imageFilenames = new Map<string, string>(); // src → filename
  const usedFilenames = new Set<string>();

  function getImageFilename(src: string): string {
    if (imageFilenames.has(src)) return imageFilenames.get(src)!;
    let filename;
    try {
      const urlPath = new URL(src, window.location.origin).pathname;
      filename = urlPath.split('/').pop() || 'image.png';
    } catch {
      filename = 'image.png';
    }
    // Deduplicate
    let base = filename;
    let counter = 1;
    while (usedFilenames.has(filename)) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        filename = `${base.substring(0, dot)}-${counter}${base.substring(dot)}`;
      } else {
        filename = `${base}-${counter}`;
      }
      counter++;
    }
    usedFilenames.add(filename);
    imageFilenames.set(src, filename);
    return filename;
  }

  // Custom rule: image rewrite
  turndownService.addRule('image-rewrite', {
    filter: 'img',
    replacement: (content: any, node: any) => {
      const src = node.getAttribute('src');
      if (!src) return '';
      const alt = node.getAttribute('alt') || '';
      const filename = getImageFilename(src);
      return `![${alt}](images/${filename})`;
    }
  });

  // --- Phase 6: Convert each chunk through Turndown ---
  const mdParts: string[] = [];
  for (const frag of fragments) {
    const html = frag.innerHTML;
    if (html.trim()) {
      mdParts.push(turndownService.turndown(html));
    }
  }

  // --- Phase 7: Build footnotes section ---
  const footnoteDefs: string[] = [];

  // Regular footnotes
  for (const fnId of footnoteRefIds) {
    const num = footnoteLabels.get(fnId);
    if (num == null) continue; // not referenced in body
    const paragraphs = footnoteContents.get(fnId) || ['(footnote)'];
    const first = paragraphs[0];
    const rest = paragraphs.slice(1);
    let def = `[^${num}]: ${first}`;
    for (const p of rest) {
      def += `\n\n    ${p.split('\n').join('\n    ')}`;
    }
    footnoteDefs.push(def);
  }

  // Hypercite footnotes
  for (const [elementId, num] of footnoteLabels) {
    if (!hyperciteContents.has(elementId)) continue; // skip regular footnotes
    const citation = hyperciteContents.get(elementId);
    footnoteDefs.push(`[^${num}]: ${citation}`);
  }

  // --- Phase 8: Build references section ---
  let referencesMd = '';
  if (referencesData.length > 0) {
    const refLines = ['## References', ''];
    for (const ref of referencesData) {
      const refMd = citationHtmlToMarkdown(ref.content);
      refLines.push(refMd);
      refLines.push('');
    }
    referencesMd = refLines.join('\n');
  }

  // --- Phase 9: Join body + footnotes + references ---
  const sections = [mdParts.join('\n\n')];
  if (footnoteDefs.length > 0) {
    sections.push('---\n\n' + footnoteDefs.join('\n\n'));
  }
  if (referencesMd) {
    sections.push('---\n\n' + referencesMd);
  }
  const markdown = sections.join('\n\n');

  // Collect image sources for bundling
  const images = imageUrls.size > 0
    ? Array.from(imageUrls).map(src => ({ src, filename: getImageFilename(src) }))
    : [];

  return { markdown, images };
}

/**
 * Public helper: build + download in one go.
 */
export async function exportBookAsMarkdown(bookId: any = book || 'latest') {
  try {
    const { markdown, images } = await buildMarkdownForBook(bookId);

    if (images.length > 0) {
      // Bundle as zip with images
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const mdName = await getBookDownloadName(bookId, 'md');
      zip.file(mdName, markdown);

      const imgFolder = zip.folder('images');
      for (const { src, filename } of images) {
        try {
          const resp = await fetch(src);
          const blob = await resp.blob();
          imgFolder.file(filename, blob);
        } catch (e) {
          console.warn('Failed to fetch image for zip:', src, e);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = await getBookDownloadName(bookId, 'zip');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log(`✅ Markdown + images exported as zip`);
    } else {
      const filename = await getBookDownloadName(bookId, 'md');
      downloadMarkdown(filename, markdown);
      console.log(`✅ Markdown exported to ${filename}`);
    }
  } catch (err) {
    console.error('❌ Failed to export markdown:', err);
  }
}

/**
 * Triggers a download in the browser of the given text as a .md file.
 */
function downloadMarkdown(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Walk a DOM node and return either Paragraphs or Runs.
// Runs of type TextRun must be created with their styling flags upfront.
function htmlElementToDocx(node: any, docxComponents: any, opts: any = {}): any[] {
  const { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, footnoteMap, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun } = docxComponents;
  const out: any[] = [];

  node.childNodes.forEach((child: any) => {
    if (child.nodeType === Node.TEXT_NODE) {
      // plain text
      const runOpts: any = { text: child.textContent, font: "Helvetica" };
      if (opts.bold) runOpts.bold = true;
      if (opts.italics) runOpts.italics = true;
      if (opts.superScript) runOpts.superScript = true;
      if (opts.subScript) runOpts.subScript = true;
      out.push(new TextRun(runOpts));
    }
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();

      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = ({
            h1: HeadingLevel.HEADING_1,
            h2: HeadingLevel.HEADING_2,
            h3: HeadingLevel.HEADING_3,
            h4: HeadingLevel.HEADING_4,
            h5: HeadingLevel.HEADING_5,
            h6: HeadingLevel.HEADING_6,
          } as any)[tag];
          const headingRuns = htmlElementToDocx(child, docxComponents, opts);
          out.push(
            new Paragraph({
              children: headingRuns,
              heading: level,
            })
          );
          break;
        }

        case 'strong':
        case 'b': {
          htmlElementToDocx(child, docxComponents, { ...opts, bold: true }).forEach((item: any) => out.push(item));
          break;
        }

        case 'em':
        case 'i': {
          htmlElementToDocx(child, docxComponents, { ...opts, italics: true }).forEach((item: any) => out.push(item));
          break;
        }

        case 'sup': {
          // Footnote reference → Word footnote
          if (child.classList?.contains('footnote-ref') && child.id && footnoteMap?.has(child.id)) {
            out.push(new FootnoteReferenceRun(footnoteMap.get(child.id)));
            break;
          }
          // Hypercite open icon → skip (handled by parent <a>)
          if (child.classList?.contains('open-icon')) {
            break;
          }
          // Regular superscript
          htmlElementToDocx(child, docxComponents, { ...opts, superScript: true }).forEach((item: any) => out.push(item));
          break;
        }

        case 'sub': {
          htmlElementToDocx(child, docxComponents, { ...opts, subScript: true }).forEach((item: any) => out.push(item));
          break;
        }

        case 'a': {
          // Hypercite arrow link → Word footnote
          if ((child.classList?.contains('open-icon') || child.querySelector?.('sup.open-icon')) && child.id && footnoteMap?.has(child.id)) {
            out.push(new FootnoteReferenceRun(footnoteMap.get(child.id)));
            break;
          }
          // Citation ref (no href) → plain text
          if (child.classList?.contains('citation-ref')) {
            out.push(new TextRun({ text: child.textContent, font: "Helvetica" }));
            break;
          }
          // Regular external hyperlink
          const url = child.getAttribute('href') || '';
          const text = child.textContent;
          out.push(
            new ExternalHyperlink({
              link: url,
              children: [
                new TextRun({
                  text,
                  font: "Helvetica",
                  style: 'Hyperlink',
                }),
              ],
            })
          );
          break;
        }

        case 'br': {
          out.push(new TextRun({ text: '\n', font: "Helvetica" }));
          break;
        }

        case 'p': {
          const pChildren = htmlElementToDocx(child, docxComponents, opts);
          out.push(new Paragraph({ children: pChildren, style: "Normal" }));
          break;
        }

        case 'blockquote': {
          const inner = htmlElementToDocx(child, docxComponents, { ...opts, italics: true });
          let bqBuf: any[] = [];
          const flush = () => {
            if (bqBuf.length) {
              out.push(new Paragraph({
                children: bqBuf,
                indent: { left: 720 },
                style: "Normal",
              }));
              bqBuf = [];
            }
          };
          inner.forEach((item: any) => {
            if (item instanceof Paragraph) {
              flush();
              // Push the nested paragraph as-is (it already has its own content)
              out.push(item);
            } else {
              bqBuf.push(item);
            }
          });
          flush();
          break;
        }

        case 'ul':
        case 'ol': {
          const isOrdered = tag === 'ol';
          const ref = isOrdered ? 'numbered-list' : 'bullet-list';
          const level = opts.listLevel || 0;
          const instance = docxComponents.nextListInstance++;

          child.childNodes.forEach((li: any) => {
            if (li.nodeType !== Node.ELEMENT_NODE) return;
            if (li.tagName.toLowerCase() !== 'li') return;

            // Separate inline content from nested lists
            const tempDiv = document.createElement('div');
            const nestedLists: any[] = [];
            li.childNodes.forEach((liChild: any) => {
              const liTag = liChild.nodeType === Node.ELEMENT_NODE && liChild.tagName.toLowerCase();
              if (liTag === 'ul' || liTag === 'ol') {
                nestedLists.push(liChild);
              } else {
                tempDiv.appendChild(liChild.cloneNode(true));
              }
            });

            // Unwrap <p> tags inside <li> content so they become inline runs
            // (marked produces <li><p>text</p></li> but docx needs inline content for numbering)
            tempDiv.querySelectorAll(':scope > p').forEach((p: any) => {
              while (p.firstChild) {
                p.parentNode.insertBefore(p.firstChild, p);
              }
              p.remove();
            });

            const liRuns = htmlElementToDocx(tempDiv, docxComponents, opts);
            const runs = liRuns.filter((item: any) => !(item instanceof Paragraph));
            const paras = liRuns.filter((item: any) => item instanceof Paragraph);

            // Main list item paragraph with Word numbering
            if (runs.length) {
              out.push(new Paragraph({
                children: runs,
                numbering: { reference: ref, level, instance },
              }));
            }
            paras.forEach((p: any) => out.push(p));

            // Nested lists at deeper level — wrap in a container so the walker hits the <ul>/<ol> tag
            for (const nested of nestedLists) {
              const wrapper = document.createElement('div');
              wrapper.appendChild(nested.cloneNode(true));
              htmlElementToDocx(wrapper, docxComponents, { ...opts, listLevel: level + 1 })
                .forEach((item: any) => out.push(item));
            }
          });
          break;
        }

        case 'pre': {
          const codeEl = child.querySelector('code');
          const text = codeEl ? codeEl.textContent : child.textContent;
          const lines = text.split('\n');
          lines.forEach((line: any) => {
            out.push(new Paragraph({
              children: [
                new TextRun({
                  text: line || ' ',
                  font: "Courier New",
                }),
              ],
              spacing: { after: 0, line: 240 },
            }));
          });
          break;
        }

        case 'code': {
          // Inline code
          const codeOpts: any = { text: child.textContent, font: "Courier New" };
          if (opts.bold) codeOpts.bold = true;
          if (opts.italics) codeOpts.italics = true;
          out.push(new TextRun(codeOpts));
          break;
        }

        case 'table': {
          if (!Table) break;
          const rows: any[] = [];
          const trElements = child.querySelectorAll('tr');
          // Count max columns from first row to distribute width evenly
          const firstTr = trElements[0];
          const colCount = firstTr ? firstTr.querySelectorAll('th, td').length : 1;
          // Use DXA (twips) for reliable cross-platform rendering
          // Standard page: 8.5" with 1" margins = 6.5" content = 9360 twips
          const totalTableWidth = 9360;
          const cellWidthDxa = Math.floor(totalTableWidth / colCount);
          const columnWidths = Array(colCount).fill(cellWidthDxa);

          trElements.forEach((tr: any) => {
            const cells: any[] = [];
            tr.querySelectorAll('th, td').forEach((cell: any) => {
              const isTh = cell.tagName.toLowerCase() === 'th';
              const cellItems = htmlElementToDocx(cell, docxComponents, isTh ? { ...opts, bold: true } : opts);
              // Group runs into paragraphs
              const cellParas: any[] = [];
              let cellBuf: any[] = [];
              cellItems.forEach((item: any) => {
                if (item instanceof Paragraph) {
                  if (cellBuf.length) {
                    cellParas.push(new Paragraph({ children: cellBuf }));
                    cellBuf = [];
                  }
                  cellParas.push(item);
                } else {
                  cellBuf.push(item);
                }
              });
              if (cellBuf.length) cellParas.push(new Paragraph({ children: cellBuf }));
              if (cellParas.length === 0) cellParas.push(new Paragraph({ children: [] }));

              cells.push(new TableCell({
                children: cellParas,
                width: { size: cellWidthDxa, type: WidthType.DXA },
              }));
            });
            if (cells.length > 0) {
              rows.push(new TableRow({ children: cells }));
            }
          });
          if (rows.length > 0) {
            out.push(new Table({
              rows,
              columnWidths,
              width: { size: totalTableWidth, type: WidthType.DXA },
            }));
          }
          break;
        }

        case 'img': {
          if (!ImageRun) break;
          const src = child.getAttribute('src');
          if (src) {
            const rawW = child.getAttribute('width');
            const rawH = child.getAttribute('height');
            const imgWidth = parseInt(rawW, 10) || 400;
            const imgHeight = parseInt(rawH, 10) || 300;
            out.push({ __imagePlaceholder: true, src, width: imgWidth, height: imgHeight, hasWidth: !!rawW, hasHeight: !!rawH });
          }
          break;
        }

        default:
          // everything else: recurse inline
          htmlElementToDocx(child, docxComponents, opts).forEach((item: any) => out.push(item));
      }
    }
  });

  return out;
}

// Build the docx with styled runs/headings/links
async function buildDocxWithStyles(bookId: any = book || 'latest') {
  if ((window as any)._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../pageLoad');
    await waitForBackgroundDownload();
  }
  const docxLib = await loadDocxLib();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, LevelFormat, AlignmentType } = docxLib;
  const chunks: any = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a: any, b: any) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();

  // --- Phase 1: Parse all chunks into DOM fragments ---
  const fragments: any[] = [];
  for (const chunk of chunks) {
    const frag: any = parser.parseFromString(
      `<div>${chunk.content || chunk.html}</div>`,
      'text/html'
    ).body.firstChild;
    fragments.push(frag);
  }

  // --- Phase 2: Pre-scan fragments for footnote refs and hypercite arrows ---
  const footnoteMap = new Map<string, number>();       // elementId → footnoteNumber
  const footnoteDefinitions: any = {};      // { number: { children: [Paragraph, ...] } }
  let fnCounter = 1;

  // Collect footnote ref IDs
  const footnoteRefIds: any[] = [];
  // Collect hypercite arrow elements: { id, targetBookId }
  const hyperciteArrows: any[] = [];
  // Collect citation ref IDs for References section
  const citationRefIds: any[] = [];

  for (const frag of fragments) {
    // Footnote refs: <sup class="footnote-ref" id="Fn...">
    frag.querySelectorAll('sup.footnote-ref[id]').forEach((sup: any) => {
      if (!footnoteMap.has(sup.id)) {
        footnoteRefIds.push(sup.id);
      }
    });

    // Citation refs: <a class="citation-ref" id="Ref...">
    frag.querySelectorAll('a.citation-ref[id]').forEach((cite: any) => {
      citationRefIds.push(cite.id);
    });

    // Hypercite arrows: <a href="..." class="open-icon">↗</a>
    frag.querySelectorAll('a[href]').forEach((anchor: any) => {
      if ((anchor.classList.contains('open-icon') || anchor.querySelector('sup.open-icon')) && anchor.id && !footnoteMap.has(anchor.id)) {
        try {
          const href = anchor.getAttribute('href');
          const urlPath = new URL(href, window.location.origin).pathname;
          // Extract book ID from first path segment (decoded)
          const segments = urlPath.split('/').filter(Boolean);
          if (segments.length > 0) {
            const parsed = new URL(href, window.location.origin);
            // Use ?scroll= instead of # — Word encodes # to %23 in external hyperlinks
            let sourceUrl = parsed.origin + parsed.pathname;
            if (parsed.hash) {
              sourceUrl += '?scroll=' + encodeURIComponent(parsed.hash.substring(1));
            }
            hyperciteArrows.push({ id: anchor.id, targetBookId: decodeURIComponent(segments[0]!), sourceUrl });
          }
        } catch (e) {
          console.warn('Failed to parse hypercite href:', anchor.getAttribute('href'), e);
        }
      }
    });
  }

  // Helper: convert HTML content to docx paragraphs (for footnote bodies)
  const htmlToFootnoteParagraphs = (htmlContent: any) => {
    const fnFrag: any = parser.parseFromString(
      `<div>${htmlContent}</div>`,
      'text/html'
    ).body.firstChild;
    // Use a simple docxComponents without footnoteMap to avoid recursion
    const fnDocxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
    const items = htmlElementToDocx(fnFrag, fnDocxComponents);
    // Group runs into paragraphs
    const paragraphs: any[] = [];
    let runBuf: any[] = [];
    items.forEach((item: any) => {
      if (item instanceof Paragraph) {
        if (runBuf.length) {
          paragraphs.push(new Paragraph({ children: runBuf }));
          runBuf = [];
        }
        paragraphs.push(item);
      } else {
        runBuf.push(item);
      }
    });
    if (runBuf.length) {
      paragraphs.push(new Paragraph({ children: runBuf }));
    }
    return paragraphs;
  };

  // --- Phase 3: Fetch footnote content from IndexedDB ---
  // Open DB once for footnote fallback lookups
  let fnDb: any;
  if (footnoteRefIds.length > 0) {
    try { fnDb = await openDatabase(); } catch (e) { console.warn('Failed to open DB for footnotes:', e); }
  }

  for (const fnId of footnoteRefIds) {
    const subBookId = `${bookId}/${fnId}`;
    try {
      // Try nodes store first (works if footnote was previously opened)
      let fnNodes: any = await getNodeChunksFromIndexedDB(subBookId);

      // Fallback: check footnotes store for preview_nodes
      if ((!fnNodes || fnNodes.length === 0) && fnDb) {
        try {
          const tx = fnDb.transaction('footnotes', 'readonly');
          const index = tx.objectStore('footnotes').index('footnoteId');
          const results: any[] = await new Promise((resolve, reject) => {
            const req = index.getAll(fnId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          // Find the record matching our parent book
          const fnRecord = results.find((r: any) => r.book === bookId);
          if (fnRecord?.preview_nodes?.length) {
            fnNodes = fnRecord.preview_nodes;
          }
        } catch (e) {
          console.warn(`Failed to look up footnotes store for ${fnId}:`, e);
        }
      }

      if (fnNodes) fnNodes.sort((a: any, b: any) => a.chunk_id - b.chunk_id);
      let fnParagraphs: any[] = [];
      for (const node of (fnNodes || [])) {
        const content = node.content || node.html || '';
        fnParagraphs.push(...htmlToFootnoteParagraphs(content));
      }
      if (fnParagraphs.length === 0) {
        fnParagraphs = [new Paragraph({ children: [new TextRun({ text: '(footnote)', font: 'Helvetica' })] })];
      }
      const num = fnCounter++;
      footnoteMap.set(fnId, num);
      footnoteDefinitions[num] = { children: fnParagraphs };
    } catch (e) {
      console.warn(`Failed to fetch footnote content for ${fnId}:`, e);
      const num = fnCounter++;
      footnoteMap.set(fnId, num);
      footnoteDefinitions[num] = { children: [new Paragraph({ children: [new TextRun({ text: '(footnote)', font: 'Helvetica' })] })] };
    }
  }

  // --- Phase 4: Fetch citation data for hypercite arrows ---
  let db: any;
  if (hyperciteArrows.length > 0) {
    try {
      db = await openDatabase();
    } catch (e) {
      console.warn('Failed to open database for hypercite citations:', e);
    }
  }

  for (const { id, targetBookId, sourceUrl } of hyperciteArrows) {
    let fnParagraphs: any[] = [];
    try {
      if (db) {
        const record = await getRecord(db, 'library', targetBookId);
        if (record?.bibtex) {
          let citationHtml: any = await formatBibtexToCitation(record.bibtex);
          if (sourceUrl) {
            if (citationHtml.includes('<a ')) {
              // Replace existing link URL with sourceUrl
              citationHtml = citationHtml.replace(/(<a\s[^>]*href=")([^"]*)(")/, `$1${sourceUrl}$3`);
            } else {
              // No link in citation — wrap just the title (italic or quoted text) in a link
              // Match <i>Title</i> or "Title"
              const titleMatch = citationHtml.match(/(<i>[^<]+<\/i>|"[^"]+")/) ;
              if (titleMatch) {
                citationHtml = citationHtml.replace(titleMatch[0], `<a href="${sourceUrl}">${titleMatch[0]}</a>`);
              } else {
                // Fallback: wrap the whole thing
                citationHtml = `<a href="${sourceUrl}">${citationHtml}</a>`;
              }
            }
          }
          fnParagraphs = htmlToFootnoteParagraphs(citationHtml);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch citation for ${targetBookId}:`, e);
    }
    if (fnParagraphs.length === 0) {
      // Fallback: create a linked citation with the target book ID
      const linkChildren = sourceUrl
        ? [new ExternalHyperlink({
            link: sourceUrl,
            children: [new TextRun({ text: targetBookId, font: "Helvetica", style: 'Hyperlink' })],
          })]
        : [new TextRun({ text: targetBookId, font: 'Helvetica' })];
      fnParagraphs = [new Paragraph({ children: linkChildren })];
    }
    const num = fnCounter++;
    footnoteMap.set(id, num);
    footnoteDefinitions[num] = { children: fnParagraphs };
  }

  // --- Phase 4b: Fetch citation content from bibliography store for References section ---
  const referencesData: any[] = [];
  if (citationRefIds.length > 0) {
    let bibDb: any;
    try { bibDb = db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for bibliography:', e); }
    if (bibDb) {
      const seenSourceIds = new Set<any>();
      for (const refId of citationRefIds) {
        try {
          const tx = bibDb.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const record: any = await new Promise((resolve, reject) => {
            const req = store.get([bookId, refId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          // Dedup key: prefer canonical_source_id (true citation identity) over
          // source_id (the specific version). Without this, multiple citations
          // pointing to the same canonical-only work would all collapse on a
          // shared null source_id.
          const dedupKey = record?.canonical_source_id || record?.source_id || null;
          if (record?.content && !seenSourceIds.has(dedupKey)) {
            seenSourceIds.add(dedupKey);
            referencesData.push({ content: record.content });
          }
        } catch (e) {
          console.warn(`Failed to fetch bibliography record for ${refId}:`, e);
        }
      }
    }
  }

  // --- Phase 5: Convert fragments to docx elements ---
  const docxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, footnoteMap, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
  const children: any[] = [];

  // Debug: count element types for diagnostics
  const tagCounts: any = {};

  for (const frag of fragments) {
    // Log what top-level tag is inside each fragment's wrapper div
    frag.childNodes.forEach((child: any) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    });

    const runsAndParas = htmlElementToDocx(frag, docxComponents);

    // group Runs into Paragraphs; Tables and image placeholders are block-level
    let buf: any[] = [];
    runsAndParas.forEach((item: any) => {
      const isBlock = (item instanceof Paragraph) || (item instanceof Table) || item?.__imagePlaceholder;
      if (isBlock) {
        if (buf.length) {
          children.push(new Paragraph({ children: buf, style: "Normal" }));
          buf = [];
        }
        children.push(item);
      } else {
        buf.push(item);
      }
    });
    if (buf.length) {
      children.push(new Paragraph({ children: buf, style: "Normal" }));
    }
  }

  console.log('📊 DOCX export tag summary:', tagCounts);

  // --- Phase 6: Append References section ---
  if (referencesData.length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'References', font: 'Helvetica' })],
      heading: HeadingLevel.HEADING_2,
      pageBreakBefore: true,
    }));
    for (const ref of referencesData) {
      const refFrag: any = parser.parseFromString(
        `<div>${ref.content}</div>`,
        'text/html'
      ).body.firstChild;
      const refDocxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
      const refItems = htmlElementToDocx(refFrag, refDocxComponents);
      let refBuf: any[] = [];
      refItems.forEach((item: any) => {
        const isBlock = (item instanceof Paragraph) || (item instanceof Table) || item?.__imagePlaceholder;
        if (isBlock) {
          if (refBuf.length) {
            children.push(new Paragraph({ children: refBuf, style: "Normal" }));
            refBuf = [];
          }
          children.push(item);
        } else {
          refBuf.push(item);
        }
      });
      if (refBuf.length) {
        children.push(new Paragraph({ children: refBuf, style: "Normal" }));
      }
    }
  }

  // --- Phase 7: Resolve image placeholders ---
  for (let i = 0; i < children.length; i++) {
    const item = children[i];
    if (item?.__imagePlaceholder) {
      try {
        const resp = await fetch(item.src);
        const blob = await resp.blob();
        const buf = await blob.arrayBuffer();

        // Resolve natural dimensions from the image itself
        let w = item.width;
        let h = item.height;
        const hasExplicitSize = item.hasWidth && item.hasHeight;
        if (!hasExplicitSize) {
          try {
            const bmp = await createImageBitmap(blob);
            w = bmp.width;
            h = bmp.height;
            bmp.close();
          } catch (_) { /* keep defaults */ }
        }

        // Cap to fit page content width (~600px)
        if (w > 600) {
          const scale = 600 / w;
          w = Math.round(600);
          h = Math.round(h * scale);
        }
        children[i] = new Paragraph({
          children: [new ImageRun({
            data: buf,
            transformation: { width: w, height: h },
          })],
        });
      } catch (e) {
        console.warn('Failed to fetch image for docx export:', item.src, e);
        children[i] = new Paragraph({
          children: [new TextRun({ text: `[image: ${item.src}]`, font: 'Helvetica', italics: true })],
          style: 'Normal',
        });
      }
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'bullet-list',
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } }, run: { font: 'Symbol' } } },
            { level: 1, format: LevelFormat.BULLET, text: '○', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } }, run: { font: 'Courier New' } } },
            { level: 2, format: LevelFormat.BULLET, text: '▪', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 2160, hanging: 360 } }, run: { font: 'Symbol' } } },
          ],
        },
        {
          reference: 'numbered-list',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Helvetica", size: 22 },
          paragraph: { spacing: { after: 200, line: 276 } },
        },
        heading1: {
          run: { font: "Helvetica", size: 48, bold: true },
          paragraph: { spacing: { before: 360, after: 120 } },
        },
        heading2: {
          run: { font: "Helvetica", size: 36, bold: true },
          paragraph: { spacing: { before: 280, after: 100 } },
        },
        heading3: {
          run: { font: "Helvetica", size: 28, bold: true },
          paragraph: { spacing: { before: 240, after: 80 } },
        },
        heading4: {
          run: { font: "Helvetica", size: 24, bold: true },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
        heading5: {
          run: { font: "Helvetica", size: 22, bold: true },
        },
        heading6: {
          run: { font: "Helvetica", size: 22, bold: true, italics: true },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: "Helvetica", size: 22 },
          paragraph: { spacing: { after: 200, line: 276 } },
        },
      ],
    },
    footnotes: footnoteDefinitions,
    sections: [{ properties: {}, children }],
  });
  return Packer.toBlob(doc);
}

export async function exportBookAsDocxStyled(bookId: any = book || 'latest') {
  try {
    const blob = await buildDocxWithStyles(bookId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = await getBookDownloadName(bookId, 'docx');
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ Styled DOCX exported');
  } catch (e) {
    console.error('❌ export styled docx failed', e);
  }
}

// ─── EPUB Export ─────────────────────────────────────────────────────────────

function escapeXml(str: any): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const EPUB_CSS = `
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6; margin: 1em; }
h1, h2, h3, h4, h5, h6 { font-family: Helvetica, Arial, sans-serif; margin-top: 1.4em; margin-bottom: 0.4em; }
h1 { font-size: 1.8em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }
blockquote { margin: 1em 2em; padding-left: 1em; border-left: 3px solid #ccc; font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #999; padding: 0.4em 0.6em; text-align: left; }
th { background: #f0f0f0; font-weight: bold; }
img { max-width: 100%; height: auto; }
aside[epub\\:type="footnote"] { font-size: 0.85em; margin: 0.5em 0; padding: 0.5em; border-top: 1px solid #ccc; }
sup a { text-decoration: none; }
.toc-h1 { margin-left: 0; }
.toc-h2 { margin-left: 1.5em; }
.toc-h3 { margin-left: 3em; }
.toc-h4 { margin-left: 4.5em; }
.toc-h5 { margin-left: 6em; }
.toc-h6 { margin-left: 7.5em; }
`;

async function buildEpubBlob(bookId: any = book || 'latest') {
  // --- Phase 1: Fetch content ---
  if ((window as any)._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../pageLoad');
    await waitForBackgroundDownload();
  }
  const JSZip = await loadJSZip();
  const chunks: any = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a: any, b: any) => a.chunk_id - b.chunk_id);

  // Fetch library metadata
  const db = await openDatabase();
  const libraryRecord = await getRecord(db, 'library', bookId);
  const bookTitle = libraryRecord?.title || libraryRecord?.book || bookId;
  const bookAuthor = libraryRecord?.author || libraryRecord?.creator || 'Unknown';
  const bookLang = libraryRecord?.language || 'en';

  const parser = new DOMParser();

  // --- Phase 2: Parse & pre-scan ---
  const fragments: any[] = [];
  for (const chunk of chunks) {
    const frag: any = parser.parseFromString(
      `<div>${chunk.content || chunk.html}</div>`,
      'text/html'
    ).body.firstChild;
    fragments.push(frag);
  }

  const tocEntries: any[] = [];      // { level, text, id }
  const footnoteRefIds: any[] = [];
  const hyperciteArrows: any[] = [];
  const citationRefIds: any[] = [];
  const imageUrls = new Map<string, string>(); // src → filename

  let headingCounter = 0;
  let imgCounter = 0;

  for (const frag of fragments) {
    // Headings
    frag.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h: any) => {
      const level = parseInt(h.tagName.substring(1));
      const id = h.id || `heading-${++headingCounter}`;
      h.id = id;
      tocEntries.push({ level, text: h.textContent.trim(), id });
    });

    // Footnote refs
    frag.querySelectorAll('sup.footnote-ref[id]').forEach((sup: any) => {
      if (!footnoteRefIds.includes(sup.id)) {
        footnoteRefIds.push(sup.id);
      }
    });

    // Citation refs
    frag.querySelectorAll('a.citation-ref[id]').forEach((cite: any) => {
      citationRefIds.push(cite.id);
    });

    // Hypercite arrows
    frag.querySelectorAll('a[href]').forEach((anchor: any) => {
      if ((anchor.classList.contains('open-icon') || anchor.querySelector('sup.open-icon')) && anchor.id) {
        try {
          const href = anchor.getAttribute('href');
          const urlPath = new URL(href, window.location.origin).pathname;
          const segments = urlPath.split('/').filter(Boolean);
          if (segments.length > 0) {
            hyperciteArrows.push({ id: anchor.id, targetBookId: decodeURIComponent(segments[0]!) });
          }
        } catch (e) {
          console.warn('Failed to parse hypercite href:', anchor.getAttribute('href'), e);
        }
      }
    });

    // Images
    frag.querySelectorAll('img[src]').forEach((img: any) => {
      const src = img.getAttribute('src');
      if (src && !imageUrls.has(src)) {
        const ext = (src.split('.').pop() || 'png').split('?')[0].toLowerCase();
        const validExt = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext) ? ext : 'png';
        imageUrls.set(src, `img-${++imgCounter}.${validExt}`);
      }
    });
  }

  // --- Phase 3: Fetch footnote/citation content from IndexedDB ---
  const footnoteContents = new Map<string, string>(); // fnId → html string

  let fnDb: any;
  if (footnoteRefIds.length > 0) {
    try { fnDb = await openDatabase(); } catch (e) { console.warn('Failed to open DB for footnotes:', e); }
  }

  for (const fnId of footnoteRefIds) {
    const subBookId = `${bookId}/${fnId}`;
    try {
      let fnNodes: any = await getNodeChunksFromIndexedDB(subBookId);

      // Fallback: check footnotes store for preview_nodes
      if ((!fnNodes || fnNodes.length === 0) && fnDb) {
        try {
          const tx = fnDb.transaction('footnotes', 'readonly');
          const index = tx.objectStore('footnotes').index('footnoteId');
          const results: any[] = await new Promise((resolve, reject) => {
            const req = index.getAll(fnId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          const fnRecord = results.find((r: any) => r.book === bookId);
          if (fnRecord?.preview_nodes?.length) {
            fnNodes = fnRecord.preview_nodes;
          }
        } catch (e) {
          console.warn(`Failed to look up footnotes store for ${fnId}:`, e);
        }
      }

      if (fnNodes) fnNodes.sort((a: any, b: any) => a.chunk_id - b.chunk_id);
      let html = '';
      for (const node of (fnNodes || [])) {
        html += (node.content || node.html || '');
      }
      footnoteContents.set(fnId, html || '<p>(footnote)</p>');
    } catch (e) {
      console.warn(`Failed to fetch footnote content for ${fnId}:`, e);
      footnoteContents.set(fnId, '<p>(footnote)</p>');
    }
  }

  // Fetch hypercite citation text
  const hyperciteContents = new Map<string, string>(); // id → html string
  let hcDb: any;
  if (hyperciteArrows.length > 0) {
    try { hcDb = db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for hypercites:', e); }
  }

  for (const { id, targetBookId } of hyperciteArrows) {
    try {
      if (hcDb) {
        const record = await getRecord(hcDb, 'library', targetBookId);
        if (record?.bibtex) {
          const citationHtml = await formatBibtexToCitation(record.bibtex);
          hyperciteContents.set(id, citationHtml || `<p>${escapeXml(targetBookId)}</p>`);
        } else {
          hyperciteContents.set(id, `<p>${escapeXml(targetBookId)}</p>`);
        }
      } else {
        hyperciteContents.set(id, `<p>${escapeXml(targetBookId)}</p>`);
      }
    } catch (e) {
      console.warn(`Failed to fetch citation for ${targetBookId}:`, e);
      hyperciteContents.set(id, `<p>${escapeXml(targetBookId)}</p>`);
    }
  }

  // Fetch bibliography entries for References section
  const referencesData: any[] = [];
  if (citationRefIds.length > 0) {
    let bibDb: any;
    try { bibDb = hcDb || db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for bibliography:', e); }
    if (bibDb) {
      const seenSourceIds = new Set<any>();
      for (const refId of citationRefIds) {
        try {
          const tx = bibDb.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const record: any = await new Promise((resolve, reject) => {
            const req = store.get([bookId, refId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          // Dedup key: prefer canonical_source_id (true citation identity) over
          // source_id (the specific version). Without this, multiple citations
          // pointing to the same canonical-only work would all collapse on a
          // shared null source_id.
          const dedupKey = record?.canonical_source_id || record?.source_id || null;
          if (record?.content && !seenSourceIds.has(dedupKey)) {
            seenSourceIds.add(dedupKey);
            referencesData.push({ content: record.content });
          }
        } catch (e) {
          console.warn(`Failed to fetch bibliography record for ${refId}:`, e);
        }
      }
    }
  }

  // --- Phase 4: Transform DOM for EPUB ---
  // Assign footnote numbers
  const footnoteMap = new Map<string, number>(); // elementId → number
  let fnCounter = 1;
  for (const fnId of footnoteRefIds) {
    footnoteMap.set(fnId, fnCounter++);
  }
  for (const { id } of hyperciteArrows) {
    if (!footnoteMap.has(id)) {
      footnoteMap.set(id, fnCounter++);
    }
  }

  for (const frag of fragments) {
    // Transform footnote refs to EPUB noterefs
    frag.querySelectorAll('sup.footnote-ref[id]').forEach((sup: any) => {
      const num = footnoteMap.get(sup.id);
      if (num == null) return;
      const a = document.createElement('a');
      a.setAttribute('epub:type', 'noteref');
      a.setAttribute('href', `#fn-${num}`);
      a.id = `fnref-${num}`;
      const supEl = document.createElement('sup');
      supEl.textContent = String(num);
      a.appendChild(supEl);
      sup.replaceWith(a);
    });

    // Transform hypercite arrows to EPUB noterefs
    frag.querySelectorAll('a[href]').forEach((anchor: any) => {
      if ((anchor.classList.contains('open-icon') || anchor.querySelector('sup.open-icon')) && anchor.id) {
        const num = footnoteMap.get(anchor.id);
        if (num == null) return;
        const a = document.createElement('a');
        a.setAttribute('epub:type', 'noteref');
        a.setAttribute('href', `#fn-${num}`);
        a.id = `fnref-${num}`;
        const supEl = document.createElement('sup');
        supEl.textContent = String(num);
        a.appendChild(supEl);
        anchor.replaceWith(a);
      }
    });

    // Strip citation-ref anchors to plain spans
    frag.querySelectorAll('a.citation-ref').forEach((cite: any) => {
      const span = document.createElement('span');
      span.innerHTML = cite.innerHTML;
      if (cite.id) span.id = cite.id;
      cite.replaceWith(span);
    });

    // Rewrite image src paths
    frag.querySelectorAll('img[src]').forEach((img: any) => {
      const src = img.getAttribute('src');
      const filename = imageUrls.get(src);
      if (filename) {
        img.setAttribute('src', `images/${filename}`);
      }
    });

    // Ensure all headings have id attributes
    frag.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h: any) => {
      if (!h.id) {
        h.id = `heading-${++headingCounter}`;
      }
    });
  }

  // --- Phase 5: Split content into per-chapter files ---
  const chapters: any[] = [{ html: '', headingIds: [] }]; // start with preamble chapter
  const headingToChapter = new Map<string, number>(); // headingId → chapter index

  for (const frag of fragments) {
    for (const child of Array.from(frag.childNodes) as any[]) {
      // Start a new chapter at each h1 or h2
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'H1' || child.tagName === 'H2')) {
        chapters.push({ html: '', headingIds: [] });
      }
      const chIdx = chapters.length - 1;
      if (child.nodeType === Node.ELEMENT_NODE) {
        chapters[chIdx].html += child.outerHTML;
        // Track heading IDs for TOC mapping
        if (/^H[1-6]$/i.test(child.tagName) && child.id) {
          chapters[chIdx].headingIds.push(child.id);
          headingToChapter.set(child.id, chIdx);
        }
        child.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h: any) => {
          if (h.id) {
            chapters[chIdx].headingIds.push(h.id);
            headingToChapter.set(h.id, chIdx);
          }
        });
      } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        chapters[chIdx].html += child.textContent;
      }
    }
  }

  // Remove empty preamble chapter
  if (!chapters[0].html.trim()) {
    chapters.shift();
    for (const [id, idx] of headingToChapter) {
      headingToChapter.set(id, idx - 1);
    }
  }

  // Chapter file names
  const chapterFiles = chapters.map((_, i) => `chapter-${i}.xhtml`);

  // Build endnotes section
  let endnotesHtml = '';
  if (footnoteMap.size > 0) {
    endnotesHtml += '<section epub:type="endnotes">\n<h2>Notes</h2>\n';
    for (const [elemId, num] of footnoteMap) {
      const content = footnoteContents.get(elemId) || hyperciteContents.get(elemId) || '<p>(note)</p>';
      endnotesHtml += `<aside epub:type="footnote" id="fn-${num}">\n`;
      endnotesHtml += `<p><a href="#fnref-${num}">${num}.</a></p>\n`;
      endnotesHtml += content + '\n';
      endnotesHtml += '</aside>\n';
    }
    endnotesHtml += '</section>\n';
  }

  // Build references section
  let referencesHtml = '';
  if (referencesData.length > 0) {
    referencesHtml += '<section>\n<h2>References</h2>\n';
    for (const ref of referencesData) {
      referencesHtml += `<div class="reference">${ref.content}</div>\n`;
    }
    referencesHtml += '</section>\n';
  }

  const hasEndnotes = endnotesHtml || referencesHtml;

  // Update noteref links in chapters to point to endnotes.xhtml
  if (hasEndnotes) {
    for (let i = 0; i < chapters.length; i++) {
      chapters[i].html = chapters[i].html.replace(
        /href="#fn-(\d+)"/g,
        'href="endnotes.xhtml#fn-$1"'
      );
    }
  }

  // Track which chapter each fnref lives in, update endnote back-links
  if (hasEndnotes) {
    const fnrefToChapter = new Map<string, number>();
    chapters.forEach((ch, idx) => {
      for (const m of ch.html.matchAll(/id="fnref-(\d+)"/g)) {
        fnrefToChapter.set(m[1], idx);
      }
    });
    endnotesHtml = endnotesHtml.replace(/href="#fnref-(\d+)"/g, (match: any, num: any) => {
      const chIdx = fnrefToChapter.get(num);
      if (chIdx != null) return `href="${chapterFiles[chIdx]}#fnref-${num}"`;
      return match;
    });
  }

  // --- Phase 6: Build per-chapter XHTML files ---
  const serializer = new XMLSerializer();
  const chapterXhtmlFiles: any[] = []; // { filename, xhtml }

  for (let i = 0; i < chapters.length; i++) {
    const rawXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(bookLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(bookTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${chapters[i].html}
</body>
</html>`;

    const doc = parser.parseFromString(rawXhtml, 'application/xhtml+xml');
    const parseErrors = doc.querySelector('parsererror');
    let xhtml;
    if (parseErrors) {
      console.warn(`EPUB: XHTML parse error in ${chapterFiles[i]}, falling back to HTML parse + serialize`);
      const htmlDoc = parser.parseFromString(rawXhtml, 'text/html');
      let serializedBody = '';
      for (const child of htmlDoc.body.childNodes as any) {
        serializedBody += serializer.serializeToString(child);
      }
      xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(bookLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(bookTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${serializedBody}
</body>
</html>`;
    } else {
      xhtml = serializer.serializeToString(doc);
    }
    chapterXhtmlFiles.push({ filename: chapterFiles[i], xhtml });
  }

  // Build endnotes XHTML file
  let endnotesXhtml = '';
  if (hasEndnotes) {
    const rawEndnotes = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(bookLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>Notes</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${endnotesHtml}
${referencesHtml}
</body>
</html>`;

    const endDoc = parser.parseFromString(rawEndnotes, 'application/xhtml+xml');
    const endErrors = endDoc.querySelector('parsererror');
    if (endErrors) {
      console.warn('EPUB: XHTML parse error in endnotes, falling back to HTML parse + serialize');
      const htmlDoc = parser.parseFromString(rawEndnotes, 'text/html');
      let serializedBody = '';
      for (const child of htmlDoc.body.childNodes as any) {
        serializedBody += serializer.serializeToString(child);
      }
      endnotesXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(bookLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>Notes</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${serializedBody}
</body>
</html>`;
    } else {
      endnotesXhtml = serializer.serializeToString(endDoc);
    }
  }

  // --- Phase 7: Build TOC ---
  let tocItems = '';
  for (const entry of tocEntries) {
    const chIdx = headingToChapter.get(entry.id);
    const file = chIdx != null ? chapterFiles[chIdx] : chapterFiles[0];
    tocItems += `    <li class="toc-h${entry.level}"><a href="${escapeXml(file)}#${escapeXml(entry.id)}">${escapeXml(entry.text)}</a></li>\n`;
  }

  const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${tocItems}    </ol>
  </nav>
</body>
</html>`;

  // --- Phase 8: Build metadata (content.opf) ---
  const uid = `urn:uuid:${crypto.randomUUID()}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  let manifestImages = '';
  let imgIdx = 0;
  for (const [, filename] of imageUrls) {
    const ext = filename.split('.').pop();
    const mimeMap: any = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
    const mime = mimeMap[ext as any] || 'image/png';
    manifestImages += `    <item id="img-${imgIdx++}" href="images/${escapeXml(filename)}" media-type="${mime}"/>\n`;
  }

  // Build manifest and spine entries for chapter files
  let manifestChapters = '';
  let spineChapters = '';
  for (let i = 0; i < chapterFiles.length; i++) {
    manifestChapters += `    <item id="chapter-${i}" href="${chapterFiles[i]}" media-type="application/xhtml+xml"/>\n`;
    spineChapters += `    <itemref idref="chapter-${i}"/>\n`;
  }

  // Add endnotes to manifest and spine if present
  let manifestEndnotes = '';
  let spineEndnotes = '';
  if (hasEndnotes) {
    manifestEndnotes = `    <item id="endnotes" href="endnotes.xhtml" media-type="application/xhtml+xml"/>\n`;
    spineEndnotes = `    <itemref idref="endnotes"/>\n`;
  }

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator>${escapeXml(bookAuthor)}</dc:creator>
    <dc:language>${escapeXml(bookLang)}</dc:language>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestChapters}${manifestEndnotes}    <item id="style" href="style.css" media-type="text/css"/>
${manifestImages}  </manifest>
  <spine>
${spineChapters}${spineEndnotes}  </spine>
</package>`;

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  // --- Phase 9: Fetch images ---
  const imageBlobs = new Map<string, any>(); // filename → blob
  for (const [src, filename] of imageUrls) {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      imageBlobs.set(filename, blob);
    } catch (e) {
      console.warn('Failed to fetch image for EPUB:', src, e);
    }
  }

  // --- Phase 10: Assemble ZIP ---
  const zip = new JSZip();
  // mimetype must be first entry, uncompressed
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', containerXml);
  zip.file('OEBPS/content.opf', contentOpf);
  zip.file('OEBPS/toc.xhtml', tocXhtml);

  for (const { filename, xhtml } of chapterXhtmlFiles) {
    zip.file(`OEBPS/${filename}`, xhtml);
  }
  if (hasEndnotes) {
    zip.file('OEBPS/endnotes.xhtml', endnotesXhtml);
  }

  zip.file('OEBPS/style.css', EPUB_CSS);

  for (const [filename, blob] of imageBlobs) {
    zip.file(`OEBPS/images/${filename}`, blob);
  }

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

export async function exportBookAsEpub(bookId: any = book || 'latest') {
  try {
    const blob = await buildEpubBlob(bookId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = await getBookDownloadName(bookId, 'epub');
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ EPUB exported');
  } catch (e) {
    console.error('❌ export EPUB failed', e);
  }
}

// Folder/vault ingestion: turn a dropped folder (or loose multi-file drop)
// into an import plan — which files become books, and which images belong to
// which markdown file.
//
// The canonical hard case is an Obsidian vault: many .md files sharing an
// attachments folder. Each .md becomes its own book, bundled with exactly the
// images it references — via standard `![alt](path)` markdown (Obsidian
// URL-encodes spaces) AND wikilink embeds `![[image.png]]` (basename-only
// resolution anywhere in the vault). An image referenced by several notes is
// copied into EVERY referencing bundle: the server flattens a book's images
// into its own media/ dir by basename (FileHelpers::updateMarkdownImagePaths),
// so per-book duplication is exactly what its rewrite expects.
//
// Wikilink embeds are REWRITTEN client-side to standard image syntax in the
// uploaded blob — the server engine has zero wikilink support, so without
// this step vault images would never render. Non-image wikilinks
// ([[Other Note]]) are left untouched (cross-note linking is a non-goal).
//
// Pure logic — no DOM. Traversal helpers take the DataTransferItemList
// (entries must be captured synchronously in the drop handler, before any
// await, or the browser invalidates them).

import { verbose } from '../../utilities/logger';
import { isAcceptableImportExt } from '../utilities/fileImportHelpers';

export interface CollectedFile {
  file: File;
  /** Path relative to the drop root, e.g. "attachments/fig 1.png". */
  relPath: string;
}

export interface ImportBundle {
  /** The document that becomes the book (md, pdf, epub, ...). */
  mainFile: File;
  /** For md bundles: the images this markdown references. */
  images: File[];
  /** For md bundles: the markdown with wikilink image embeds rewritten. */
  rewrittenMain: File | null;
  title: string;
  filename: string;
}

export interface IngestPlan {
  /**
   * none: nothing importable.
   * single: exactly one document — use the existing single-file form flow.
   * one-book-folder: one .md (+ images) — the existing md+images path.
   * batch: N documents → N books via the batch uploader.
   */
  kind: 'none' | 'single' | 'one-book-folder' | 'batch';
  files: File[];
  bundles: ImportBundle[];
  /** Folder name when a single directory was dropped, else null. */
  folderName: string | null;
  source: 'files' | 'folder' | 'vault';
  /** Images in the drop referenced by no markdown file (skipped). */
  unreferencedImages: number;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);

const TRAVERSAL_MAX_FILES = 300;
const TRAVERSAL_MAX_DEPTH = 12;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(name));
}

function isMarkdownFile(name: string): boolean {
  return extOf(name) === 'md';
}

function basenameOf(path: string): string {
  const clean = path.replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function titleFromFilename(name: string): string {
  const base = basenameOf(name);
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim() || base;
}

/* ── Traversal ──────────────────────────────────────────────────────────── */

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (entries: EntryLike[]) => void, err?: (e: unknown) => void) => void };
}

/**
 * Capture webkitGetAsEntry() entries SYNCHRONOUSLY from a drop event's
 * dataTransfer. Must run before any await — entries are invalidated once the
 * event handler yields. Returns null when the entries API is unavailable.
 */
export function captureDropEntries(dataTransfer: DataTransfer): EntryLike[] | null {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return null;
  const first = items[0] as DataTransferItem & { webkitGetAsEntry?: () => unknown };
  if (typeof first.webkitGetAsEntry !== 'function') return null;

  const entries: EntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DataTransferItem & { webkitGetAsEntry?: () => unknown };
    const entry = item.webkitGetAsEntry ? (item.webkitGetAsEntry() as EntryLike | null) : null;
    if (entry) entries.push(entry);
  }
  return entries.length ? entries : null;
}

function entryFile(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file((f) => resolve(f), () => resolve(null));
  });
}

function readAllDirEntries(entry: EntryLike): Promise<EntryLike[]> {
  return new Promise((resolve) => {
    if (!entry.createReader) return resolve([]);
    const reader = entry.createReader();
    const all: EntryLike[] = [];
    const readBatch = () => {
      // readEntries returns <=100 entries per call and must be re-called
      // until it yields an empty batch.
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        readBatch();
      }, () => resolve(all));
    };
    readBatch();
  });
}

/**
 * Recursively read captured entries into files with root-relative paths.
 * Caps: 300 files / depth 12 — a vault bigger than that needs the picker.
 */
export async function collectEntries(entries: EntryLike[]): Promise<{ files: CollectedFile[]; rootDirName: string | null }> {
  const files: CollectedFile[] = [];
  // Folder name only when the drop was exactly one directory.
  const firstEntry = entries[0];
  const rootDirName = entries.length === 1 && firstEntry?.isDirectory ? firstEntry.name : null;

  const walk = async (entry: EntryLike, prefix: string, depth: number): Promise<void> => {
    if (files.length >= TRAVERSAL_MAX_FILES || depth > TRAVERSAL_MAX_DEPTH) return;
    if (entry.isFile) {
      const f = await entryFile(entry);
      if (f) files.push({ file: f, relPath: prefix ? `${prefix}/${entry.name}` : entry.name });
      return;
    }
    if (entry.isDirectory) {
      // Skip Obsidian's config dir — plugins/themes, never content.
      if (entry.name === '.obsidian') return;
      const children = await readAllDirEntries(entry);
      for (const child of children) {
        if (files.length >= TRAVERSAL_MAX_FILES) break;
        // A single dropped directory IS the root: its own name stays out of
        // relPaths so bundles look the same as a loose multi-file drop.
        const childPrefix = entry === firstEntry && rootDirName ? prefix : (prefix ? `${prefix}/${entry.name}` : entry.name);
        await walk(child, childPrefix, depth + 1);
      }
    }
  };

  for (const entry of entries) {
    await walk(entry, '', 0);
  }
  return { files, rootDirName };
}

/**
 * Adapt a file-input selection (the picker's `multiple` / `webkitdirectory`)
 * to the same CollectedFile shape as a drop. webkitRelativePath (present for
 * folder picks) carries "Vault/sub/note.md" — the shared first segment is the
 * folder name and is stripped from relPaths, mirroring collectEntries.
 */
export function collectPickedFiles(files: File[]): { files: CollectedFile[]; rootDirName: string | null } {
  type PickedFile = File & { webkitRelativePath?: string };
  let rootDirName: string | null = null;

  const firstRel = (files[0] as PickedFile)?.webkitRelativePath || '';
  if (firstRel.includes('/')) {
    const root = firstRel.slice(0, firstRel.indexOf('/'));
    const allShareRoot = files.every((f) => ((f as PickedFile).webkitRelativePath || '').startsWith(`${root}/`));
    if (allShareRoot) rootDirName = root;
  }

  const collected = files.map((f) => {
    const rel = (f as PickedFile).webkitRelativePath || f.name;
    const relPath = rootDirName && rel.startsWith(`${rootDirName}/`) ? rel.slice(rootDirName.length + 1) : rel;
    return { file: f, relPath };
  });

  return { files: collected, rootDirName };
}

/**
 * Convert a single/one-book-folder plan into a batch of one bundle. Used when
 * a drop lands while ANOTHER import is running: the form is occupied by its
 * progress card (no file input to attach to), so the drop queues behind it as
 * a batch instead of being silently discarded.
 */
export function planAsBatch(plan: IngestPlan): IngestPlan {
  if (plan.kind === 'batch' || plan.kind === 'none') return plan;
  const [main, ...rest] = plan.files;
  if (!main) return { ...plan, kind: 'none', files: [], bundles: [] };
  return {
    ...plan,
    kind: 'batch',
    files: [],
    bundles: [{
      mainFile: main,
      images: rest.filter((f) => isImageFile(f.name)),
      rewrittenMain: null,
      title: titleFromFilename(main.name),
      filename: main.name,
    }],
  };
}

/* ── Markdown image references ──────────────────────────────────────────── */

/**
 * Image basenames (lowercased) referenced by a markdown text, from both
 * standard `![alt](path)` refs and wikilink embeds `![[name.png]]` /
 * `![[name.png|alias]]`. Paths are URL-decoded (Obsidian encodes spaces) and
 * anchors/size suffixes stripped; non-image targets are ignored.
 */
export function parseImageRefs(mdText: string): Set<string> {
  const refs = new Set<string>();

  const addRef = (raw: string) => {
    let target = raw.trim();
    const hash = target.indexOf('#');
    if (hash >= 0) target = target.slice(0, hash);
    try {
      target = decodeURIComponent(target);
    } catch { /* malformed escape — use as-is */ }
    const base = basenameOf(target).toLowerCase();
    if (base && isImageFile(base)) refs.add(base);
  };

  // Standard: ![alt](path "title") / ![alt](<path with spaces>)
  const standard = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = standard.exec(mdText)) !== null) {
    if (m[1]) addRef(m[1]);
  }

  // Wikilink embeds: ![[target]] / ![[target|alias]] / ![[target#anchor]]
  const wikilink = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  while ((m = wikilink.exec(mdText)) !== null) {
    if (m[1]) addRef(m[1]);
  }

  return refs;
}

/**
 * Rewrite wikilink IMAGE embeds to standard markdown image syntax:
 *   ![[fig 1.png]]        → ![fig 1](fig%201.png)
 *   ![[fig 1.png|caption]] → ![caption](fig%201.png)
 * The emitted path is the URL-encoded basename — the server flattens a book's
 * images into media/ and rewrites refs by (URL-decoded) basename, so this is
 * exactly the shape its one-book folder path expects. Non-image wikilinks
 * (and everything else) pass through untouched.
 */
export function rewriteWikilinkImageEmbeds(mdText: string): string {
  return mdText.replace(
    /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
    (whole, target: string, alias: string | undefined) => {
      const base = basenameOf(target.trim());
      if (!isImageFile(base)) return whole;
      const alt = (alias || titleFromFilename(base)).trim();
      return `![${alt}](${encodeURIComponent(base)})`;
    },
  );
}

/* ── Plan building ──────────────────────────────────────────────────────── */

/**
 * Decide what a drop becomes. Rules:
 *  - exactly ONE .md (± images, no other docs) → the existing one-book
 *    md+images folder path, untouched;
 *  - two or more .md (the vault case) → one book per md, images routed by
 *    reference (other doc files in the folder become their own books too);
 *  - zero .md, one importable doc → the single-file form flow;
 *  - zero .md, several docs → one book per doc.
 */
export async function buildIngestPlan(
  collected: CollectedFile[],
  rootDirName: string | null,
): Promise<IngestPlan> {
  const importable = collected.filter((c) => isAcceptableImportExt(c.file));
  const mds = importable.filter((c) => isMarkdownFile(c.file.name));
  const images = importable.filter((c) => isImageFile(c.file.name));
  const docs = importable.filter((c) => !isMarkdownFile(c.file.name) && !isImageFile(c.file.name));

  if (importable.length === 0) {
    return { kind: 'none', files: [], bundles: [], folderName: rootDirName, source: 'files', unreferencedImages: 0 };
  }

  // One markdown file, no other documents: the classic one-book folder.
  const onlyMd = mds[0];
  if (mds.length === 1 && onlyMd && docs.length === 0) {
    return {
      kind: 'one-book-folder',
      files: [onlyMd.file, ...images.map((i) => i.file)],
      bundles: [],
      folderName: rootDirName,
      source: 'folder',
      unreferencedImages: 0,
    };
  }

  // No markdown: single doc → existing flow; several → plain batch.
  if (mds.length === 0) {
    const onlyDoc = docs[0];
    if (docs.length === 1 && onlyDoc && images.length === 0) {
      return { kind: 'single', files: [onlyDoc.file], bundles: [], folderName: rootDirName, source: 'files', unreferencedImages: 0 };
    }
    const onlyImportable = importable[0];
    if (docs.length === 0 && importable.length === 1 && onlyImportable) {
      // A lone image is importable as a book in the existing flow.
      return { kind: 'single', files: [onlyImportable.file], bundles: [], folderName: rootDirName, source: 'files', unreferencedImages: images.length ? images.length - 1 : 0 };
    }
    const bundles = docs.map((d) => ({
      mainFile: d.file,
      images: [],
      rewrittenMain: null,
      title: titleFromFilename(d.file.name),
      filename: d.file.name,
    }));
    if (images.length) {
      verbose.content(`folderIngest: ${images.length} image(s) in a no-markdown drop are skipped`, '/components/importQueue/folderIngest.ts');
    }
    return {
      kind: bundles.length ? 'batch' : 'none',
      files: [],
      bundles,
      folderName: rootDirName,
      source: rootDirName ? 'folder' : 'files',
      unreferencedImages: images.length,
    };
  }

  // Vault mode: >=2 mds (or md + other docs) → one book per document, images
  // routed to every md that references them (by basename, Obsidian-style).
  const imagesByBasename = new Map<string, File>();
  for (const img of images) {
    const key = basenameOf(img.file.name).toLowerCase();
    if (imagesByBasename.has(key)) {
      // Same-named images in different subfolders collide when the server
      // flattens to media/<basename> — first one wins, loudly.
      verbose.content(`folderIngest: duplicate image basename "${key}" — keeping the first`, '/components/importQueue/folderIngest.ts');
      continue;
    }
    imagesByBasename.set(key, img.file);
  }

  const referenced = new Set<string>();
  const bundles: ImportBundle[] = [];

  for (const md of mds) {
    const text = await md.file.text();
    const refs = parseImageRefs(text);
    const bundleImages: File[] = [];
    for (const ref of refs) {
      const img = imagesByBasename.get(ref);
      if (img) {
        bundleImages.push(img);
        referenced.add(ref);
      }
      // Refs to images not in the drop are left as-is — the server logs
      // "Image reference not found" and keeps the original ref.
    }

    const rewritten = rewriteWikilinkImageEmbeds(text);
    const rewrittenMain = rewritten === text
      ? null
      : new File([rewritten], md.file.name, { type: md.file.type || 'text/markdown' });

    bundles.push({
      mainFile: md.file,
      images: bundleImages,
      rewrittenMain,
      title: titleFromFilename(md.file.name),
      filename: md.file.name,
    });
  }

  for (const doc of docs) {
    bundles.push({
      mainFile: doc.file,
      images: [],
      rewrittenMain: null,
      title: titleFromFilename(doc.file.name),
      filename: doc.file.name,
    });
  }

  const unreferenced = images.filter((i) => !referenced.has(basenameOf(i.file.name).toLowerCase())).length;
  if (unreferenced) {
    verbose.content(`folderIngest: ${unreferenced} image(s) referenced by no markdown file — skipped`, '/components/importQueue/folderIngest.ts');
  }

  return {
    kind: 'batch',
    files: [],
    bundles,
    folderName: rootDirName,
    source: 'vault',
    unreferencedImages: unreferenced,
  };
}

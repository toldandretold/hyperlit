// Folder/vault ingestion: the pure planning logic behind multi-file and
// Obsidian-vault drops. Pins:
//  - parseImageRefs sees BOTH standard `![](path)` refs (URL-encoded, with
//    anchors/titles) and wikilink embeds `![[name|alias]]`, images only;
//  - rewriteWikilinkImageEmbeds converts image wikilinks to standard syntax
//    (URL-encoded basename) and leaves note links untouched;
//  - buildIngestPlan routing: 1 md (+images) = one-book folder; >=2 md = vault
//    (one bundle per md, shared image duplicated into every referencing
//    bundle, unreferenced images skipped); 0 md = single/batch by doc count;
//  - collectPickedFiles derives the folder name from webkitRelativePath.

import { describe, test, expect } from 'vitest';
import {
  parseImageRefs,
  rewriteWikilinkImageEmbeds,
  buildIngestPlan,
  collectPickedFiles,
  planAsBatch,
} from '../../../resources/js/components/importQueue/folderIngest';

const mdFile = (name, text) => new File([text], name, { type: 'text/markdown' });
const imgFile = (name) => new File(['fakepng'], name, { type: 'image/png' });
const pdfFile = (name) => new File(['fakepdf'], name, { type: 'application/pdf' });

const collected = (file, relPath = null) => ({ file, relPath: relPath || file.name });

describe('parseImageRefs', () => {
  test('standard refs: URL-decoded, anchor-stripped, basename-only, images only', () => {
    const refs = parseImageRefs([
      '![fig](attachments/fig%201.png)',
      '![other](../deep/dir/plot.jpeg "a title")',
      '![anchored](chart.png#center)',
      '[not an image link](notes.md)',
      '![](document.pdf)', // non-image target ignored
    ].join('\n'));

    expect(refs).toEqual(new Set(['fig 1.png', 'plot.jpeg', 'chart.png']));
  });

  test('wikilink embeds: with alias, anchor, and non-image targets ignored', () => {
    const refs = parseImageRefs([
      '![[shared diagram.png]]',
      '![[Fig2.JPG|the second figure]]',
      '![[chart.svg#section]]',
      '[[Another Note]]',      // plain note link — not an embed
      '![[Some Note]]',        // embed of a NOTE, not an image
    ].join('\n'));

    expect(refs).toEqual(new Set(['shared diagram.png', 'fig2.jpg', 'chart.svg']));
  });
});

describe('rewriteWikilinkImageEmbeds', () => {
  test('rewrites image embeds to standard syntax with encoded basename', () => {
    const out = rewriteWikilinkImageEmbeds('before ![[fig 1.png]] after');
    expect(out).toBe('before ![fig 1](fig%201.png) after');
  });

  test('uses the alias as alt text and strips anchors', () => {
    expect(rewriteWikilinkImageEmbeds('![[chart.png|My Chart]]')).toBe('![My Chart](chart.png)');
    expect(rewriteWikilinkImageEmbeds('![[chart.png#top|My Chart]]')).toBe('![My Chart](chart.png)');
  });

  test('leaves note wikilinks and note embeds untouched', () => {
    const text = 'see [[Other Note]] and ![[Embedded Note]]';
    expect(rewriteWikilinkImageEmbeds(text)).toBe(text);
  });
});

describe('buildIngestPlan routing', () => {
  test('one md plus images is the classic one-book folder', async () => {
    const plan = await buildIngestPlan(
      [collected(mdFile('main.md', '![](a.png)')), collected(imgFile('a.png'))],
      'MyBook',
    );
    expect(plan.kind).toBe('one-book-folder');
    expect(plan.files.map((f) => f.name)).toEqual(['main.md', 'a.png']);
    expect(plan.folderName).toBe('MyBook');
  });

  test('a single document routes to the existing single-file flow', async () => {
    const plan = await buildIngestPlan([collected(pdfFile('paper.pdf'))], null);
    expect(plan.kind).toBe('single');
    expect(plan.files.map((f) => f.name)).toEqual(['paper.pdf']);
  });

  test('several documents with no md become a plain batch', async () => {
    const plan = await buildIngestPlan(
      [collected(pdfFile('one.pdf')), collected(pdfFile('two.pdf'))],
      'Papers',
    );
    expect(plan.kind).toBe('batch');
    expect(plan.source).toBe('folder');
    expect(plan.bundles.map((b) => b.filename)).toEqual(['one.pdf', 'two.pdf']);
  });

  test('vault: one bundle per md, shared image copied into every referencing bundle', async () => {
    const shared = imgFile('shared.png');
    const only1 = imgFile('only1.png');
    const orphan = imgFile('orphan.png');

    const plan = await buildIngestPlan([
      collected(mdFile('note1.md', '![](attachments/shared.png)\n![[only1.png]]')),
      collected(mdFile('note2.md', '![[shared.png|the shared one]]')),
      collected(shared, 'attachments/shared.png'),
      collected(only1, 'attachments/only1.png'),
      collected(orphan, 'attachments/orphan.png'),
    ], 'Vault');

    expect(plan.kind).toBe('batch');
    expect(plan.source).toBe('vault');
    expect(plan.bundles).toHaveLength(2);

    const [b1, b2] = plan.bundles;
    expect(b1.images.map((f) => f.name).sort()).toEqual(['only1.png', 'shared.png']);
    expect(b2.images.map((f) => f.name)).toEqual(['shared.png']);
    expect(plan.unreferencedImages).toBe(1); // orphan.png

    // note2 used a wikilink embed → its upload carries the rewritten blob.
    expect(b2.rewrittenMain).not.toBeNull();
    const rewritten = await b2.rewrittenMain.text();
    expect(rewritten).toBe('![the shared one](shared.png)');
    // note1 used only syntax the server understands (plus a wikilink) — it
    // referenced only1.png via wikilink, so it too gets a rewrite.
    expect(b1.rewrittenMain).not.toBeNull();
  });

  test('vault with extra documents gives each doc its own bundle in the same batch', async () => {
    const plan = await buildIngestPlan([
      collected(mdFile('a.md', 'text')),
      collected(mdFile('b.md', 'text')),
      collected(pdfFile('paper.pdf')),
    ], 'Vault');

    expect(plan.kind).toBe('batch');
    expect(plan.bundles.map((b) => b.filename)).toEqual(['a.md', 'b.md', 'paper.pdf']);
  });

  test('nothing importable yields none', async () => {
    const junk = new File(['x'], 'app.exe');
    const plan = await buildIngestPlan([collected(junk)], null);
    expect(plan.kind).toBe('none');
  });
});

describe('planAsBatch (drop while another import is running)', () => {
  test('a single-doc plan becomes a batch of one bundle', async () => {
    const plan = await buildIngestPlan([collected(pdfFile('paper.pdf'))], null);
    const asBatch = planAsBatch(plan);
    expect(asBatch.kind).toBe('batch');
    expect(asBatch.bundles).toHaveLength(1);
    expect(asBatch.bundles[0].filename).toBe('paper.pdf');
    expect(asBatch.bundles[0].images).toHaveLength(0);
  });

  test('a one-book-folder plan keeps its images in the bundle', async () => {
    const plan = await buildIngestPlan(
      [collected(mdFile('main.md', '![](a.png)')), collected(imgFile('a.png'))],
      'MyBook',
    );
    const asBatch = planAsBatch(plan);
    expect(asBatch.kind).toBe('batch');
    expect(asBatch.bundles).toHaveLength(1);
    expect(asBatch.bundles[0].mainFile.name).toBe('main.md');
    expect(asBatch.bundles[0].images.map((f) => f.name)).toEqual(['a.png']);
  });

  test('batch and none plans pass through untouched', async () => {
    const batchPlan = await buildIngestPlan(
      [collected(pdfFile('one.pdf')), collected(pdfFile('two.pdf'))],
      null,
    );
    expect(planAsBatch(batchPlan)).toBe(batchPlan);

    const nonePlan = await buildIngestPlan([collected(new File(['x'], 'app.exe'))], null);
    expect(planAsBatch(nonePlan)).toBe(nonePlan);
  });
});

describe('collectPickedFiles', () => {
  const withRelPath = (file, rel) => {
    Object.defineProperty(file, 'webkitRelativePath', { value: rel });
    return file;
  };

  test('derives folder name from a shared webkitRelativePath root', () => {
    const files = [
      withRelPath(mdFile('a.md', ''), 'Vault/a.md'),
      withRelPath(imgFile('x.png'), 'Vault/attachments/x.png'),
    ];
    const { files: out, rootDirName } = collectPickedFiles(files);
    expect(rootDirName).toBe('Vault');
    expect(out.map((c) => c.relPath)).toEqual(['a.md', 'attachments/x.png']);
  });

  test('loose picks (no relative path) keep plain names and no folder', () => {
    const { files: out, rootDirName } = collectPickedFiles([pdfFile('one.pdf'), pdfFile('two.pdf')]);
    expect(rootDirName).toBeNull();
    expect(out.map((c) => c.relPath)).toEqual(['one.pdf', 'two.pdf']);
  });
});

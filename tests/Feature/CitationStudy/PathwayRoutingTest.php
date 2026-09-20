<?php

/**
 * Pathway plumbing: a corpus book must import through the SAME processor a
 * real user's document would, and every result must be taggable with the
 * pathway that produced its text.
 *
 * This exists because the harness used to decide the format with a binary
 * `.html ? html : md` check — a .pdf or .docx corpus source was copied to
 * original.md and fed to the MARKDOWN processor, so multi-pathway corpora
 * were impossible and the study could only ever measure one path (a
 * convert→export→re-convert round-trip that no user performs).
 */

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\StudyBookImporter;
use Illuminate\Support\Facades\File;

const PATHWAY_ROOT = 'storage/framework/testing/citation-study-pathways';

function pathwayCorpus(array $books): CorpusManifest
{
    config(['study.root' => PATHWAY_ROOT]);
    $dir = base_path(PATHWAY_ROOT . '/corpora/pathtest');
    File::ensureDirectoryExists($dir . '/sources');
    File::put($dir . '/manifest.json', json_encode([
        'corpus' => 'pathtest',
        'frozen' => false,
        'books' => $books,
    ]));
    return CorpusManifest::load('pathtest');
}

function pathwayBook(array $overrides = []): array
{
    return array_merge([
        'slug' => 'fixture',
        'arm' => 'control',
        'source_file' => 'sources/fixture/original.md',
        'ground_truth' => 'sources/fixture/ground_truth.json',
        'default_label' => 'intact',
    ], $overrides);
}

afterEach(function () {
    File::deleteDirectory(base_path(PATHWAY_ROOT));
});

// ── Extension routing ────────────────────────────────────────────────────────

test('every supported source extension routes to its real processor', function () {
    expect(StudyBookImporter::pipelineExtension('/x/original.pdf'))->toBe('pdf')
        ->and(StudyBookImporter::pipelineExtension('/x/original.html'))->toBe('html')
        ->and(StudyBookImporter::pipelineExtension('/x/original.htm'))->toBe('html')
        ->and(StudyBookImporter::pipelineExtension('/x/original.md'))->toBe('md')
        ->and(StudyBookImporter::pipelineExtension('/x/original.docx'))->toBe('docx')
        ->and(StudyBookImporter::pipelineExtension('/x/original.epub'))->toBe('epub')
        // Case-insensitive: a .PDF from a user's filesystem is still a PDF.
        ->and(StudyBookImporter::pipelineExtension('/x/ORIGINAL.PDF'))->toBe('pdf');
});

test('an unsupported extension fails loudly instead of silently importing as markdown', function () {
    // The old binary check made this a SILENT markdown import.
    expect(fn () => StudyBookImporter::pipelineExtension('/x/original.pages'))
        ->toThrow(RuntimeException::class, 'Unsupported study-file extension');
});

// ── Manifest pathway key ─────────────────────────────────────────────────────

test('pathway is derived from the source extension when not declared', function () {
    $manifest = pathwayCorpus([
        pathwayBook(['slug' => 'a', 'source_file' => 'sources/a/original.pdf']),
        pathwayBook(['slug' => 'b', 'source_file' => 'sources/b/original.html']),
        pathwayBook(['slug' => 'c', 'source_file' => 'sources/c/original.md']),
        pathwayBook(['slug' => 'd', 'source_file' => 'sources/d/original.docx']),
        pathwayBook(['slug' => 'e', 'source_file' => 'sources/e/original.epub']),
    ]);
    expect($manifest->pathwayFor($manifest->book('a')))->toBe('pdf')
        ->and($manifest->pathwayFor($manifest->book('b')))->toBe('html')
        ->and($manifest->pathwayFor($manifest->book('c')))->toBe('markdown')
        ->and($manifest->pathwayFor($manifest->book('d')))->toBe('docx')
        ->and($manifest->pathwayFor($manifest->book('e')))->toBe('epub');
});

test('an explicit pathway wins over the extension — paste is a .html source', function () {
    // A paste capture IS an .html file, but it must run the paste engine, not
    // the HTML document processor. Only the explicit key can say so.
    $manifest = pathwayCorpus([
        pathwayBook(['slug' => 'p', 'source_file' => 'sources/p/original.html', 'pathway' => 'paste']),
    ]);
    expect($manifest->pathwayFor($manifest->book('p')))->toBe('paste');
});

test('an invalid pathway is rejected at manifest load', function () {
    expect(fn () => pathwayCorpus([pathwayBook(['pathway' => 'telepathy'])]))
        ->toThrow(RuntimeException::class, 'invalid pathway');
});

// ── Adopt a raw source file ──────────────────────────────────────────────────

test('adopt --file copies the real source and tags its pathway', function () {
    config(['study.root' => PATHWAY_ROOT]);
    $src = base_path(PATHWAY_ROOT . '/incoming/My Article.md');
    File::ensureDirectoryExists(dirname($src));
    File::put($src, "# Title\n\nBody with (Smith, 2019).\n\n## References\n\nSmith J (2019) A work.\n");

    $this->artisan('citation:study:adopt', [
        'corpus' => 'pathtest',
        '--file' => $src,
        '--arm' => 'control',
        '--slug' => 'my-article',
        '--title' => 'My Article',
    ])->assertExitCode(0);

    $manifest = CorpusManifest::load('pathtest');
    $book = $manifest->book('my-article');
    expect($book['source_file'])->toBe('sources/my-article/original.md')
        ->and($book['provenance']['source_markdown'])->toBe('raw-file')
        ->and($book['provenance']['original_file'])->toBe('My Article.md')
        // No library book behind it — that's the point of raw-file adoption.
        ->and($book['provenance']['source_book_id'])->toBeNull()
        ->and($manifest->pathwayFor($book))->toBe('markdown');
    expect(is_file($manifest->path($book['source_file'])))->toBeTrue();
});

test('adopt --file refuses a paste pathway that is not an html capture', function () {
    config(['study.root' => PATHWAY_ROOT]);
    $src = base_path(PATHWAY_ROOT . '/incoming/notes.md');
    File::ensureDirectoryExists(dirname($src));
    File::put($src, "# notes\n");

    $this->artisan('citation:study:adopt', [
        'corpus' => 'pathtest',
        '--file' => $src,
        '--pathway' => 'paste',
        '--slug' => 'nope',
    ])->assertExitCode(1);
});

test('adopt --file refuses a synthetic-arm source that is not markdown', function () {
    // The corruptor edits TEXT — it cannot seed corruptions into a PDF.
    config(['study.root' => PATHWAY_ROOT]);
    $src = base_path(PATHWAY_ROOT . '/incoming/paper.pdf');
    File::ensureDirectoryExists(dirname($src));
    File::put($src, '%PDF-1.4 stub');

    $this->artisan('citation:study:adopt', [
        'corpus' => 'pathtest',
        '--file' => $src,
        '--arm' => 'synthetic',
        '--slug' => 'nope2',
    ])->assertExitCode(1);
});

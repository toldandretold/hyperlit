<?php

/**
 * Freezing a corpus hashes every file; verification fails on any mutation,
 * addition, or deletion. The runner refuses to run a frozen corpus that fails
 * verification — the guarantee behind "the reported runs used exactly the
 * frozen inputs".
 */

use App\Services\CitationStudy\CorpusLock;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Support\Facades\File;

const LOCK_ROOT = 'storage/framework/testing/citation-study-lock';

function lockWriteCorpus(): CorpusManifest
{
    config(['study.root' => LOCK_ROOT]);
    $dir = base_path(LOCK_ROOT . '/corpora/locktest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# Fixture\n\nBody (Alder, 2010).\n\n## References\n\nAlder, P. (2010). Ref. *J*, 1, 1-2.\n");
    File::put(base_path(LOCK_ROOT . '/corpora/locktest/manifest.json'), json_encode([
        'corpus' => 'locktest',
        'frozen' => true,
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'control',
            'source_file' => 'sources/fixture/original.md',
            'default_label' => 'intact',
        ]],
    ]));
    return CorpusManifest::load('locktest');
}

afterEach(function () {
    File::deleteDirectory(base_path(LOCK_ROOT));
});

test('freeze then verify passes clean', function () {
    $manifest = lockWriteCorpus();
    $lock = new CorpusLock();
    $frozen = $lock->freeze($manifest);

    expect($frozen['files'])->toHaveCount(2) // manifest.json + original.md
        ->and($lock->verify($manifest))->toBe([]);
});

test('mutating a byte fails verification, naming the file', function () {
    $manifest = lockWriteCorpus();
    $lock = new CorpusLock();
    $lock->freeze($manifest);

    File::append($manifest->path('sources/fixture/original.md'), 'x');
    $problems = $lock->verify($manifest);
    expect($problems)->toHaveCount(1)
        ->and($problems[0])->toContain('sources/fixture/original.md');
});

test('adding or removing a file fails verification', function () {
    $manifest = lockWriteCorpus();
    $lock = new CorpusLock();
    $lock->freeze($manifest);

    File::put($manifest->path('sources/fixture/extra.md'), 'new');
    expect($lock->verify($manifest)[0])->toContain('New file');

    File::delete($manifest->path('sources/fixture/extra.md'));
    File::delete($manifest->path('sources/fixture/original.md'));
    expect($lock->verify($manifest)[0])->toContain('Missing file');
});

test('assertClean throws with the corpus name for a dirty frozen corpus', function () {
    $manifest = lockWriteCorpus();
    $lock = new CorpusLock();
    $lock->freeze($manifest);
    File::append($manifest->path('manifest.json'), ' ');

    expect(fn () => $lock->assertClean($manifest))
        ->toThrow(RuntimeException::class, 'locktest');
});

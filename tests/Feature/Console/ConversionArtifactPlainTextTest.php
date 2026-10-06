<?php

/**
 * ConversionArtifactSaver (the vibe-accept / reconvert artifact-swap path) —
 * plainText derivation for the import lane.
 *
 * The four import-lane writers (this one, ProcessDocumentImportJob,
 * ContentFetchService, ImportController) used to mint `plainText => '' ` when
 * the converter artifact omitted the key — a hole FTS and embeddings can never
 * see, immune to the 2026-08 IS NULL-only backfill. They now route through
 * EncryptedBookGuard::plainTextFor: derive strip_tags(content) when the key is
 * missing/empty, preserve a crafted non-empty value.
 */

use App\Services\ConversionArtifactSaver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;

const CAPT_BOOK = 'rls_capt_derive_book';

afterEach(function () {
    File::deleteDirectory(resource_path('markdown/'.CAPT_BOOK));
});

it('derives plainText when the converter artifact omits or empties the key, preserves a crafted value', function () {
    Queue::fake();

    $user = $this->seedUser();
    $this->seedLibrary(['book' => CAPT_BOOK, 'creator' => $user->name, 'creator_token' => $user->user_token]);

    $path = resource_path('markdown/'.CAPT_BOOK);
    File::ensureDirectoryExists($path);
    File::put($path.'/nodes.json', json_encode([
        ['content' => '<p>no key at all</p>', 'type' => 'p'],
        ['content' => '<p>empty <em>key</em></p>', 'type' => 'p', 'plainText' => ''],
        ['content' => '<div>card html</div>', 'type' => 'p', 'plainText' => 'crafted citation text'],
    ]));

    // saveAll (not saveNodes directly) — it's the real entry point and the one
    // that establishes the owner RLS context before writing.
    app(ConversionArtifactSaver::class)->saveAll($path, CAPT_BOOK);

    $rows = DB::table('nodes')->where('book', CAPT_BOOK)->orderBy('startLine')->pluck('plainText');
    expect($rows->all())->toBe(['no key at all', 'empty key', 'crafted citation text']);
});

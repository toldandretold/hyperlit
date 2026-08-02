<?php

/**
 * Scope + safety rules for `harvest:audit-imports`.
 *
 * The first version of this command matched on `creator = canonicalizer_v1`,
 * which SUB-BOOKS INHERIT — so every annotation and footnote sub-book was
 * audited as though it were a work. A footnote is one paragraph, so it scored
 * zero prose blocks and was reported as a missing article body. On prod that
 * produced 3,851 "suspects" out of 4,015 and flooded /maintainer/conversion
 * with rows like "Annotation: seq1_Fn1784048776750_0cbo".
 *
 * Every test here exists to stop that recurring.
 */

use App\Models\ConversionFlag;
use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function auditDb()
{
    return DB::connection('pgsql_admin');
}

/** Seed a library row + N nodes of the given text length. */
function auditSeedBook(array $opts = []): string
{
    $book = $opts['book'] ?? ('book_audit_' . Str::random(8));
    auditDb()->table('library')->insert([
        'book'              => $book,
        'title'             => $opts['title'] ?? 'A Harvested Work',
        'visibility'        => 'public',
        'listed'            => false,
        'has_nodes'         => true,
        // array_key_exists, NOT ?? — an explicitly-null option (the user-upload
        // case) must stay null rather than falling back to the harvester value.
        'creator'           => array_key_exists('creator', $opts) ? $opts['creator'] : AutoVersionResolver::CREATOR,
        'foundation_source' => array_key_exists('foundation_source', $opts) ? $opts['foundation_source'] : AutoVersionResolver::FOUNDATION_SOURCE,
        'conversion_method' => array_key_exists('conversion_method', $opts) ? $opts['conversion_method'] : 'paste_engine_html',
        'raw_json'          => '[]',
        'timestamp'         => 0,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $paragraphs = $opts['paragraphs'] ?? 0;
    $text = str_repeat('Ordinary article prose that carries real meaning across the sentence. ', 8);
    for ($i = 1; $i <= $paragraphs; $i++) {
        auditDb()->table('nodes')->insert([
            'book'      => $book,
            'chunk_id'  => 1,
            'startLine' => $i * 100,
            'node_id'   => "{$book}_n{$i}",
            'content'   => "<p>{$text}</p>",
            'plainText' => $text,
            'type'      => 'p',
        ]);
    }

    return $book;
}

function auditCleanup(array $books): void
{
    foreach ($books as $book) {
        auditDb()->table('nodes')->where('book', $book)->delete();
        auditDb()->table('library')->where('book', $book)->delete();
        DB::table('conversion_flags')->where('book', $book)->delete();
    }
}

test('sub-books are never audited — a footnote is not a work', function () {
    $parent = auditSeedBook(['paragraphs' => 40]);
    // An annotation sub-book: one paragraph, id carries the slash.
    $sub = auditSeedBook([
        'book'       => $parent . '/seq1_Fn1784048776750_0cbo',
        'title'      => 'Annotation: seq1_Fn1784048776750_0cbo',
        'paragraphs' => 1,
    ]);

    try {
        $this->artisan('harvest:audit-imports --all')
            ->doesntExpectOutputToContain($sub)
            ->assertSuccessful();
    } finally {
        auditCleanup([$parent, $sub]);
    }
});

test('a user upload is out of scope — only harvester output is audited', function () {
    $upload = auditSeedBook([
        'creator'           => 'someuser',
        'foundation_source' => null,
        'conversion_method' => 'epub_import',
        'paragraphs'        => 1,
    ]);

    try {
        $this->artisan('harvest:audit-imports --all')
            ->doesntExpectOutputToContain($upload)
            ->assertSuccessful();
    } finally {
        auditCleanup([$upload]);
    }
});

test('a real harvested article is not a suspect', function () {
    $good = auditSeedBook(['paragraphs' => 40]);

    try {
        $this->artisan('harvest:audit-imports --book=' . $good)
            ->doesntExpectOutputToContain('SUSPECT')
            ->assertSuccessful();
    } finally {
        auditCleanup([$good]);
    }
});

test('a body-absent harvested book IS a suspect', function () {
    $bad = auditSeedBook(['paragraphs' => 1]);

    try {
        $this->artisan('harvest:audit-imports --book=' . $bad)
            ->expectsOutputToContain('SUSPECT')
            ->assertSuccessful();
    } finally {
        auditCleanup([$bad]);
    }
});

test('an implausible suspect rate REFUSES to flag without --force', function () {
    $bad = auditSeedBook(['paragraphs' => 1]);

    try {
        // 100% of the audited slice is absent → the measure is wrong, not the corpus.
        $this->artisan('harvest:audit-imports --book=' . $bad . ' --flag')
            ->expectsOutputToContain('REFUSING to flag')
            ->assertFailed();

        expect(DB::table('conversion_flags')->where('book', $bad)->count())->toBe(0);
    } finally {
        auditCleanup([$bad]);
    }
});

test('--unflag deletes ONLY this audit\'s flags', function () {
    $bad = auditSeedBook(['paragraphs' => 1]);
    $sweepBook = 'book_audit_decoy_sweep';
    $userBook  = 'book_audit_decoy_user';

    try {
        $this->artisan('harvest:audit-imports --book=' . $bad . ' --flag --force')->assertSuccessful();
        expect(DB::table('conversion_flags')->where('book', $bad)->count())->toBe(1);

        // A library:flag-sweep flag (same source) and a user report that happens
        // to carry the same issueType — both must survive.
        ConversionFlag::raise($sweepBook, ConversionFlag::SOURCE_AUTO_SWEEP, 'garbage signatures', ['signals' => ['block_page_phrase']]);
        ConversionFlag::raise($userBook, ConversionFlag::SOURCE_USER_REPORT, 'bad', ['issueTypes' => ['body_absent']]);

        $this->artisan('harvest:audit-imports --unflag')->assertSuccessful();

        expect(DB::table('conversion_flags')->where('book', $bad)->count())->toBe(0);
        expect(DB::table('conversion_flags')->where('book', $sweepBook)->count())->toBe(1);
        expect(DB::table('conversion_flags')->where('book', $userBook)->count())->toBe(1);
    } finally {
        auditCleanup([$bad, $sweepBook, $userBook]);
    }
});

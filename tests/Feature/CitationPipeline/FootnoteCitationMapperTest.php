<?php

/**
 * CitationReview\Matching\FootnoteCitationMapper — maps footnoteId -> [refId].
 * Extracted from CitationReviewService::buildFootnoteCitationMap; this covers
 * its two detection methods, the multi-match title-overlap disambiguation, and
 * the footnote-only self-map path.
 */

use App\Services\CitationReview\Matching\FootnoteCitationMapper;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function fcmDb()
{
    return DB::connection('pgsql_admin');
}

function fcmSeedBib(string $book, string $refId, ?array $meta): void
{
    fcmDb()->table('bibliography')->insert([
        'book'         => $book,
        'referenceId'  => $refId,
        'content'      => "<p>{$refId}</p>",
        'llm_metadata' => $meta ? json_encode($meta) : null,
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);
}

function fcmSeedFootnote(string $book, string $fnId, string $content, bool $isCitation = true): void
{
    fcmDb()->table('footnotes')->insert([
        'book'        => $book,
        'footnoteId'  => $fnId,
        'is_citation' => $isCitation,
        'content'     => $content,
        'created_at'  => now(),
        'updated_at'  => now(),
    ]);
}

test('inline <a href="#refId"> links resolve to bibliography entries', function () {
    $book = 'fcm_' . Str::random(8);
    fcmSeedBib($book, 'ref_a', null);
    fcmSeedFootnote($book, 'fn1', '<p>See <a href="#ref_a">Smith</a>.</p>');
    fcmSeedFootnote($book, 'fn_bad', '<p>See <a href="#not_in_bib">X</a>.</p>');

    try {
        $map = app(FootnoteCitationMapper::class)->buildMap($book);
        expect($map)->toHaveKey('fn1');
        expect($map['fn1'])->toBe(['ref_a']);
        // A link to a refId absent from the bibliography is ignored.
        expect($map)->not->toHaveKey('fn_bad');
    } finally {
        fcmDb()->table('footnotes')->where('book', $book)->delete();
        fcmDb()->table('bibliography')->where('book', $book)->delete();
    }
});

test('author last-name + year text matching resolves a footnote', function () {
    $book = 'fcm_' . Str::random(8);
    fcmSeedBib($book, 'ref_oa', ['authors' => ['Smith, John'], 'year' => 2019, 'title' => 'The Open Access Advantage']);
    fcmSeedBib($book, 'ref_other', ['authors' => ['Nguyen, Linh'], 'year' => 2011, 'title' => 'Unrelated Monograph']);
    fcmSeedFootnote($book, 'fn1', '<p>Smith (2019) documents the open access advantage.</p>');

    try {
        $map = app(FootnoteCitationMapper::class)->buildMap($book);
        expect($map['fn1'] ?? null)->toBe(['ref_oa']);
    } finally {
        fcmDb()->table('footnotes')->where('book', $book)->delete();
        fcmDb()->table('bibliography')->where('book', $book)->delete();
    }
});

test('multiple author+year matches are disambiguated by title overlap', function () {
    $book = 'fcm_' . Str::random(8);
    // Both share surname-in-text + year 2019; only the title distinguishes them.
    fcmSeedBib($book, 'ref_oa', ['authors' => ['Smith, John'], 'year' => 2019, 'title' => 'The Open Access Advantage']);
    fcmSeedBib($book, 'ref_far', ['authors' => ['Jones, Amy'], 'year' => 2019, 'title' => 'Something Else Entirely Different Words']);
    fcmSeedFootnote($book, 'fn1', '<p>Smith and Jones 2019, open access advantage.</p>');

    try {
        $map = app(FootnoteCitationMapper::class)->buildMap($book);
        // Title-overlap picks the open-access entry, not the disjoint one.
        expect($map['fn1'] ?? null)->toBe(['ref_oa']);
    } finally {
        fcmDb()->table('footnotes')->where('book', $book)->delete();
        fcmDb()->table('bibliography')->where('book', $book)->delete();
    }
});

test('with no bibliography, citation footnotes self-map', function () {
    $book = 'fcm_' . Str::random(8);
    fcmSeedFootnote($book, 'fn10', '<p>A citation footnote.</p>', true);
    fcmSeedFootnote($book, 'fn11', '<p>Not a citation.</p>', false);

    try {
        $map = app(FootnoteCitationMapper::class)->buildMap($book);
        expect($map)->toBe(['fn10' => ['fn10']]);
    } finally {
        fcmDb()->table('footnotes')->where('book', $book)->delete();
    }
});

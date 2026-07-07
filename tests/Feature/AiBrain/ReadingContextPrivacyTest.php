<?php

/**
 * AI Brain — ReadingContextFormatter privacy re-check.
 *
 * The client attaches resolved hypercite target text as a token-saver, but the
 * SERVER is the privacy authority: a hypercite pointing at a private book the user
 * doesn't own must have its quoted text WITHHELD from the LLM preamble, even if the
 * client sent it. These tests exercise the formatter directly (no stream / no LLM),
 * seeding library rows via the BYPASSRLS admin connection.
 */

use App\Services\AiBrain\ReadingContextFormatter;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function rcpConn()
{
    return DB::connection('pgsql_admin');
}

function rcpSeedBook(string $book, string $visibility, string $creator, string $title): void
{
    rcpConn()->table('library')->updateOrInsert(['book' => $book], [
        'creator'    => $creator,
        'visibility' => $visibility,
        'listed'     => false,
        'title'      => $title,
        'type'       => 'book',
        'has_nodes'  => true,
        'raw_json'   => json_encode([]),
        'timestamp'  => 0,
    ]);
    EncryptedBookGuard::forget($book);
}

beforeEach(function () {
    $this->formatter = new ReadingContextFormatter();
    $this->user = (object) ['name' => 'reader_' . Str::random(6)];
    $this->rootMeta = ['title' => 'Capital', 'author' => 'Marx', 'year' => '1867'];
});

test('includes hypercited text when the target book is public', function () {
    $book = 'book_pub_' . Str::random(8);
    rcpSeedBook($book, 'public', 'someone_else', 'The Wealth of Nations');

    $out = $this->formatter->build([
        'hypercites' => [[
            'hyperciteId'     => 'hypercite_x',
            'targetBook'      => $book,
            'hypercitedText'  => 'value is congealed labour-time',
            'targetBookTitle' => 'The Wealth of Nations',
            'targetBookAuthor'=> 'Smith',
            'visibility'      => 'public',
        ]],
    ], $this->rootMeta, $this->user);

    expect($out)->toContain('value is congealed labour-time');
    expect($out)->toContain('The Wealth of Nations');
    expect($out)->not->toContain('withheld');
});

test('withholds hypercited text when the target book is private and not owned', function () {
    $book = 'book_priv_' . Str::random(8);
    rcpSeedBook($book, 'private', 'a_different_owner', 'Secret Manuscript');

    $out = $this->formatter->build([
        'hypercites' => [[
            'hyperciteId'     => 'hypercite_x',
            'targetBook'      => $book,
            // Client (wrongly, or from a stale cache) sent the text — server must drop it.
            'hypercitedText'  => 'THE SECRET PRIVATE PASSAGE',
            'targetBookTitle' => 'Secret Manuscript',
            'visibility'      => 'public',
        ]],
    ], $this->rootMeta, $this->user);

    expect($out)->not->toContain('THE SECRET PRIVATE PASSAGE');
    expect($out)->toContain('withheld');
});

test('renders the nesting chain, authorship, and root book citation', function () {
    $out = $this->formatter->build([
        'chain' => [
            // root → inner
            ['type' => 'footnote', 'creator' => null, 'isAi' => false],
            ['type' => 'highlight', 'creator' => 'sam', 'isAi' => false, 'label' => 'a note'],
        ],
        'chainTruncated' => false,
        'immediateContainer' => ['type' => 'highlight', 'creator' => 'sam', 'isAi' => false],
    ], $this->rootMeta, $this->user);

    expect($out)->toContain('a highlight annotation by @sam');
    expect($out)->toContain('a footnote');
    expect($out)->toContain('"Capital" by Marx (1867)');
    expect($out)->toContain('annotation left by the reader @sam');
});

test('labels an AI Archivist response as AI-authored', function () {
    $out = $this->formatter->build([
        'chain' => [['type' => 'ai-response', 'creator' => 'AIarchivist', 'isAi' => true]],
        'immediateContainer' => ['type' => 'ai-response', 'creator' => 'AIarchivist', 'isAi' => true],
    ], $this->rootMeta, $this->user);

    expect($out)->toContain('AI Archivist');
    expect($out)->toContain('written by the AI Archivist itself');
});

test('returns an empty string when there is nothing to frame', function () {
    expect($this->formatter->build(null, $this->rootMeta, $this->user))->toBe('');
    expect($this->formatter->build(['chain' => [], 'citations' => [], 'hypercites' => []], $this->rootMeta, $this->user))->toBe('');
});

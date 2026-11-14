<?php

/**
 * FootnoteSources — which works a citation footnote was matched to, as canonical ids, for the
 * reader's footnote popup. Derived read-only from the scan's columns; shipped in the footnote
 * LOAD shape by both the live path and the BookCache mirror.
 */

use App\Services\Footnotes\FootnoteSources;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

beforeEach(function () {
    $this->fsBook = 'book_fnsrc_' . Str::lower(Str::random(8));
    $this->fsAdmin = DB::connection('pgsql_admin');
    $this->fsStubs = [];
    $this->fsCanonicals = [];

    $this->fsStub = function (bool $withCanonical = true, array $cols = []): array {
        $canonical = null;
        if ($withCanonical) {
            $canonical = (string) Str::uuid();
            $this->fsAdmin->table('canonical_source')->insert([
                'id' => $canonical, 'title' => 'FnSrc Work', 'foundation_source' => 'test',
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $this->fsCanonicals[] = $canonical;
        }
        $book = (string) Str::uuid();
        $this->fsAdmin->table('library')->insert($cols + [
            'book' => $book, 'title' => 'FnSrc Stub', 'visibility' => 'private', 'has_nodes' => false,
            'canonical_source_id' => $canonical, 'raw_json' => '[]', 'timestamp' => 0,
        ]);
        $this->fsStubs[] = $book;

        return [$book, $canonical];
    };

    $this->fsFootnote = function (string $id, array $cols): void {
        $this->fsAdmin->table('footnotes')->insert(array_merge([
            'book' => $this->fsBook, 'footnoteId' => $id, 'content' => '<p>x</p>',
            'is_citation' => true, 'created_at' => now(), 'updated_at' => now(),
        ], $cols));
    };
});

afterEach(function () {
    $this->fsAdmin->table('footnotes')->where('book', $this->fsBook)->delete();
    $this->fsAdmin->table('library')->whereIn('book', $this->fsStubs)->delete();
    $this->fsAdmin->table('canonical_source')->whereIn('id', $this->fsCanonicals)->delete();
});

test('maps each citation footnote to the canonical ids of its matched works', function () {
    [$a, $canonA] = ($this->fsStub)();
    [$b, $canonB] = ($this->fsStub)();
    [$noCanon] = ($this->fsStub)(false);

    // single matched work
    ($this->fsFootnote)('Fn1', ['foundation_source' => $a]);
    // multi-work: primary + a matched sub + an unmatched sub; the parent's own book repeated in a sub
    ($this->fsFootnote)('Fn2', [
        'foundation_source' => $a,
        'llm_metadata' => json_encode(['sub_citations' => [
            ['title' => 'second', 'resolution' => ['status' => 'matched', 'book' => $b]],
            ['title' => 'third', 'resolution' => ['status' => 'no_match']],
            ['title' => 'dup', 'resolution' => ['status' => 'matched', 'book' => $a]],
        ]]),
    ]);
    // short form inherits its antecedent's foundation_source — nothing special to do
    ($this->fsFootnote)('Fn3', ['foundation_source' => $b, 'match_method' => 'short_form_antecedent']);
    // searched, nothing found
    ($this->fsFootnote)('Fn4', ['foundation_source' => 'unknown']);
    // matched a row with no canonical identity and no url — nothing to link
    ($this->fsFootnote)('Fn5', ['foundation_source' => $noCanon]);
    // matched a WEB page (WebFetch stubs carry no canonical): the original url, never the stub
    [$web] = ($this->fsStub)(false, ['type' => 'web_source', 'url' => 'https://colorlines.com/article/x/', 'title' => 'The color of violence']);
    [$webUntitled] = ($this->fsStub)(false, ['type' => 'web_source', 'url' => 'https://example.org/p', 'title' => 'Web Source']);
    ($this->fsFootnote)('Fn7', ['foundation_source' => $web, 'llm_metadata' => json_encode(['sub_citations' => [
        ['resolution' => ['status' => 'matched', 'book' => $webUntitled]],
    ]])]);
    // not a citation at all
    ($this->fsFootnote)('Fn6', ['foundation_source' => $a, 'is_citation' => false]);

    expect(FootnoteSources::forBook($this->fsBook))->toBe([
        'Fn1' => [['canonical_source_id' => $canonA]],
        'Fn2' => [['canonical_source_id' => $canonA], ['canonical_source_id' => $canonB]],
        'Fn3' => [['canonical_source_id' => $canonB]],
        'Fn7' => [
            ['url' => 'https://colorlines.com/article/x/', 'title' => 'The color of violence'],
            ['url' => 'https://example.org/p', 'title' => null],
        ],
    ]);
});

test('a book with no citation footnotes yields nothing', function () {
    ($this->fsFootnote)('Fn1', ['is_citation' => false]);

    expect(FootnoteSources::forBook($this->fsBook))->toBe([]);
});

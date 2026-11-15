<?php

/**
 * Vault round trip — export → re-import → compare → export → re-import → compare.
 *
 * A vault downloaded from Hyperlit and dropped back in must come back as the
 * same books. Before this test existed nothing checked that, and every cycle
 * degraded the book: each `[^n]:` definition stayed in the body AND became a
 * footnote (so the next export carried the notes twice), a quotation inside a
 * footnote was stored twice, Obsidian's ` ^block-id` suffix was printed into
 * the reference, and every reference came back unmatched and unverified.
 *
 * Both halves are REAL: MarkdownVaultBuilder writes the vault, and each note
 * goes through ProcessDocumentImportJob with the real MarkdownProcessor (the
 * Python conversion). Books are seeded in the HTML the editor and the importer
 * write. Two contracts:
 *
 *   1. generation 1 ≈ the original — prose, footnotes, references, citation
 *      links, reference matches + verifications, citation metadata;
 *   2. generation 2 == generation 1 — the round trip is a FIXED POINT, so a
 *      vault can cycle any number of times without drifting.
 *
 * The differences that remain are DECLARED below, as exact assertions, so they
 * can only change on purpose:
 *   - a hypercite arrow comes back as an ordinary footnote holding the
 *     citation (nothing on the import path rewires hypercites — see
 *     docs/vault-reimport.md);
 *   - an editor-inserted citation (`a.citation-ref` + its bibliography row)
 *     comes back as a document "References" section the importer links.
 *   - in the Zettlr vault, a citation with nowhere to point (no note, DOI or
 *     URL for its reference) is plain text and comes back unlinked.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Models\User;
use App\Services\BillingService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\FrontMatter;
use App\Services\DocumentImport\MetadataExtractor;
use App\Services\DocumentImport\Processors\DocxProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\PdfProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\Export\ArchiveCorpus;
use App\Services\Export\MarkdownVaultBuilder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function vrtDb()
{
    return DB::connection('pgsql_admin');
}

function vrtCleanup(): void
{
    $db = vrtDb();
    foreach (['nodes', 'footnotes', 'bibliography', 'library'] as $table) {
        $db->table($table)->where('book', 'like', 'vrtbook\_%')->delete();
    }
    $db->table('users')->where('email', 'like', 'vrt\_%@vrttest.test')->delete();
    foreach (glob(resource_path('markdown/vrtbook_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
    foreach (glob(storage_path('app/vrt-*')) ?: [] as $path) {
        is_dir($path) ? File::deleteDirectory($path) : @unlink($path);
    }
}

beforeEach(function () {
    vrtCleanup();
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});
afterEach(fn () => vrtCleanup());

function vrtUser(): User
{
    $name = 'vrt_' . Str::lower(Str::random(8));
    $id = vrtDb()->table('users')->insertGetId([
        'name'       => $name,
        'email'      => $name . '@vrttest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return User::on('pgsql_admin')->find($id);
}

function vrtLibrary(User $user, string $book, array $fields): void
{
    vrtDb()->table('library')->insert(array_merge([
        'book'          => $book,
        'creator'       => $user->name,
        'creator_token' => $user->user_token,
        'visibility'    => 'public',
        'listed'        => false,
        'type'          => 'book',
        'has_nodes'     => true,
        'raw_json'      => '[]',
        'timestamp'     => (int) round(microtime(true) * 1000),
        'created_at'    => now(),
        'updated_at'    => now(),
    ], $fields));
}

/** @param  string[]  $contents  one node's HTML each, in reading order */
function vrtNodes(string $book, array $contents): void
{
    foreach ($contents as $i => $content) {
        vrtDb()->table('nodes')->insert([
            'book'       => $book,
            'node_id'    => $book . '_n' . ($i + 1),
            'chunk_id'   => 0,
            'startLine'  => ($i + 1) * 100,
            'content'    => $content,
            'plainText'  => strip_tags($content),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}

/**
 * Two books as Hyperlit stores them. The CITING book has footnotes (one with
 * a quotation), author-year citations with a references list — one reference
 * matched to the other book and verified by a person — and a hypercite arrow.
 * The CITED book carries a citation made with the editor's citation inserter.
 *
 * @return array{0: User, 1: string, 2: string}  [owner, citing book, cited book]
 */
function vrtSeedOriginals(): array
{
    $user = vrtUser();
    $citing = 'vrtbook_citing_' . Str::lower(Str::random(6));
    $cited = 'vrtbook_cited_' . Str::lower(Str::random(6));
    $canonical = (string) Str::uuid();

    vrtLibrary($user, $cited, [
        'title' => 'Anti-Capitalist Politics', 'author' => 'David Harvey', 'year' => '2020',
        'publisher' => 'Pluto Press', 'license' => 'CC-BY-4.0',
    ]);
    vrtNodes($cited, [
        '<h1>Anti-Capitalist Politics</h1>',
        '<p>Capital circulates, and its circulation is the subject of this book (Marx <a id="Ref1700000000000_ab12" class="citation-ref">1867</a>).</p>',
        '<p>The argument proceeds in three movements, each taken up in turn below.</p>',
    ]);
    vrtDb()->table('bibliography')->insert([
        'book' => $cited, 'referenceId' => 'Ref1700000000000_ab12',
        'content' => '<p>Marx, Karl. 1867. Capital: A Critique of Political Economy. Hamburg: Otto Meissner.</p>',
        // The citation inserter links the cited book as it inserts, and the owner verified it.
        'source_id' => 'vrtbook_marx_capital', 'canonical_source_id' => (string) Str::uuid(),
        'reference_match_method' => 'user_verified', 'reference_verified_at' => now(),
        'reference_verified_by' => $user->name,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    vrtLibrary($user, $citing, [
        'title' => 'A Study of the Commons', 'author' => 'Ann Author; Bea Writer', 'year' => '2024',
        'journal' => 'Journal of Commons Studies', 'volume' => '12', 'issue' => '3',
        'doi' => '10.5555/vrt.2024.001', 'license' => 'CC-BY-4.0',
    ]);
    vrtNodes($citing, [
        '<h1>A Study of the Commons</h1>',
        '<p>The commons is older than the market<sup class="footnote-ref" id="FnVrtA1" fn-count-id="1">1</sup> and has outlived several of them.<sup class="footnote-ref" id="FnVrtA2" fn-count-id="2">2</sup></p>',
        '<p>Networks of this kind are vast and open (Harvey <a class="in-text-citation" href="#harvey2020">2020</a>; Beck <a class="in-text-citation" href="#beck1992">1992</a>).</p>',
        '<p>The point is made at length elsewhere.<a href="/' . $cited . '#hypercite_vrt1" id="hypercite_vrtarrow" class="open-icon">↗</a></p>',
        '<h2>References</h2>',
        '<p><a class="bib-entry" id="harvey2020"></a>Harvey, David. 2020. <em>Anti-Capitalist Politics</em>. London: Pluto Press.</p>',
        '<p><a class="bib-entry" id="beck1992"></a>Beck, Ulrich. 1992. <em>Risk Society: Towards a New Modernity</em>. London: Sage.</p>',
    ]);
    vrtNodes($citing . '/FnVrtA1', ['<p>A short note on enclosure.</p>']);
    vrtNodes($citing . '/FnVrtA2', [
        '<p>As one account has it:</p>',
        '<blockquote><p>the commons is about how groups of people can work together</p></blockquote>',
    ]);
    vrtDb()->table('bibliography')->insert([
        [
            'book' => $citing, 'referenceId' => 'harvey2020',
            'content' => '<p><a class="bib-entry" id="harvey2020"></a>Harvey, David. 2020. <em>Anti-Capitalist Politics</em>. London: Pluto Press.</p>',
            'source_id' => $cited, 'foundation_source' => $cited, 'canonical_source_id' => $canonical,
            'match_method' => 'title_author', 'reference_match_method' => 'user_verified',
            'reference_verified_at' => now(), 'reference_verified_by' => $user->name,
            'created_at' => now(), 'updated_at' => now(),
        ],
        [
            'book' => $citing, 'referenceId' => 'beck1992',
            'content' => '<p><a class="bib-entry" id="beck1992"></a>Beck, Ulrich. 1992. <em>Risk Society: Towards a New Modernity</em>. London: Sage.</p>',
            'source_id' => null, 'foundation_source' => 'unknown', 'canonical_source_id' => null,
            'match_method' => 'no_match', 'reference_match_method' => null,
            'reference_verified_at' => null, 'reference_verified_by' => null,
            'created_at' => now(), 'updated_at' => now(),
        ],
    ]);

    return [$user, $citing, $cited];
}

/**
 * Build a vault of exactly these books and return each note's Markdown.
 *
 * @param  string[]  $books
 * @return array<string, string>  book id => note markdown
 */
function vrtExport(User $user, array $books, string $flavor): array
{
    $rows = vrtDb()->table('library')->whereIn('book', $books)->orderBy('book')->get()->all();
    $corpus = new ArchiveCorpus(
        scopeType: 'user',
        scopeId: $user->name,
        displayName: 'Vrt Round Trip',
        citeAuthor: $user->name,
        pageUrl: url('/u/' . $user->name),
        books: $rows,
        encryptedBooks: [],
    );

    $final = storage_path('app/vrt-' . Str::random(8) . '.zip');
    app(MarkdownVaultBuilder::class)->build($corpus, $final . '.part', $final, fn () => null, $flavor);

    $zip = new ZipArchive();
    expect($zip->open($final))->toBeTrue();
    $notes = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = basename($zip->getNameIndex($i));
        if (!str_ends_with($name, '.md') || $name === 'README.md') {
            continue;
        }
        $markdown = $zip->getFromIndex($i);
        $bookKey = FrontMatter::scalar(FrontMatter::split($markdown)['fields'], 'book');
        expect($bookKey)->not->toBe('');
        $notes[$bookKey] = $markdown;
    }
    $zip->close();
    @unlink($final);

    return $notes;
}

/**
 * Import one vault note as the user's own version of $original — what the
 * folder drop does: the note's front matter fills the library row (the client
 * sends it as form fields), then the import job converts the file.
 */
function vrtImport(User $user, string $markdown, string $original): string
{
    $book = 'vrtbook_copy_' . Str::lower(Str::random(8));
    $fields = FrontMatter::split($markdown)['fields'];
    vrtLibrary($user, $book, [
        'title'     => FrontMatter::scalar($fields, 'title'),
        'author'    => implode('; ', FrontMatter::listOf($fields, 'authors', 'author')),
        'year'      => FrontMatter::scalar($fields, 'year'),
        'journal'   => FrontMatter::scalar($fields, 'journal') ?: null,
        'volume'    => FrontMatter::scalar($fields, 'volume') ?: null,
        'issue'     => FrontMatter::scalar($fields, 'issue') ?: null,
        'publisher' => FrontMatter::scalar($fields, 'publisher') ?: null,
        'doi'       => FrontMatter::scalar($fields, 'doi') ?: null,
        'license'   => FrontMatter::scalar($fields, 'license') ?: 'Unknown',
        'has_nodes' => false,
    ]);

    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.md", $markdown);

    $job = new ProcessDocumentImportJob($book, 'md', $user->id, ['inherit_citations_from' => $original], []);
    $job->handle(
        app(EpubProcessor::class),
        app(MarkdownProcessor::class),
        app(HtmlProcessor::class),
        app(PdfProcessor::class),
        app(DocxProcessor::class),
        app(ZipProcessor::class),
        app(FileHelpers::class),
        app(BillingService::class),
        app(MetadataExtractor::class),
    );

    $progress = json_decode((string) File::get("{$dir}/progress.json"), true);
    expect($progress['status'] ?? null)->toBe('complete');

    return $book;
}

function vrtText(string $html): string
{
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5);

    return trim((string) preg_replace('/\s+/u', ' ', $text));
}

/**
 * What a book IS, independent of ids and markup: its prose in order, its
 * footnotes in marker order, which reference each citation points at, its
 * references, what each reference was matched to, and its citation details.
 */
function vrtFingerprint(string $book): array
{
    $db = vrtDb();
    $contents = $db->table('nodes')->where('book', $book)->orderBy('chunk_id')->orderBy('startLine')->pluck('content');

    $references = [];
    $matches = [];
    foreach ($db->table('bibliography')->where('book', $book)->get() as $row) {
        $text = vrtText((string) $row->content);
        $references[$row->referenceId] = $text;
        $matches[$text] = [
            'source'    => $row->source_id,
            'canonical' => $row->canonical_source_id,
            'method'    => $row->match_method,
            'decision'  => $row->reference_match_method,
            'verified'  => $row->reference_verified_at !== null,
        ];
    }
    ksort($matches);

    $body = [];
    $footnoteIds = [];
    $citations = [];
    $leftovers = [];
    foreach ($contents as $content) {
        $doc = new DOMDocument();
        @$doc->loadHTML('<?xml encoding="utf-8"?><div id="vrt-root">' . $content . '</div>', LIBXML_NOERROR);
        $xpath = new DOMXPath($doc);

        foreach ($xpath->query('//sup[contains(concat(" ", normalize-space(@class), " "), " footnote-ref ")]') as $sup) {
            $footnoteIds[$sup->getAttribute('id')] = true;
        }
        foreach ($xpath->query('//a[contains(concat(" ", normalize-space(@class), " "), " in-text-citation ")]') as $a) {
            $refId = ltrim($a->getAttribute('href'), '#');
            $citations[] = trim($a->textContent) . ' → ' . ($references[$refId] ?? '(no reference)');
        }
        // Markers are not prose: a footnote number, a hypercite arrow.
        foreach (iterator_to_array($xpath->query('//sup[contains(concat(" ", normalize-space(@class), " "), " footnote-ref ")] | //a[contains(concat(" ", normalize-space(@class), " "), " open-icon ")]')) as $marker) {
            $marker->parentNode->removeChild($marker);
        }

        $text = trim((string) preg_replace('/\s+/u', ' ', $xpath->query('//*[@id="vrt-root"]')->item(0)->textContent));
        if ($text === '') {
            continue;
        }
        $body[] = $text;
        if (preg_match('/\[\^\d+\]|\s\^[A-Za-z0-9-]+$|^---$|^[a-z_]+: "/', $text)) {
            $leftovers[] = $text;
        }
    }

    $footnotes = [];
    foreach (array_keys($footnoteIds) as $fnId) {
        // Block by block: a footnote's paragraphs and quotations are part of what it is.
        $footnotes[] = $db->table('nodes')->where('book', "{$book}/{$fnId}")->orderBy('startLine')->pluck('content')
            ->map(fn ($html) => (preg_match('/^\s*<([a-z0-9]+)/i', (string) $html, $m) ? strtolower($m[1]) : '?') . ': ' . vrtText((string) $html))
            ->all();
    }

    $lib = $db->table('library')->where('book', $book)->first();
    sort($citations);
    $referenceTexts = array_values($references);
    sort($referenceTexts);

    return [
        'body'       => $body,
        'footnotes'  => $footnotes,
        'citations'  => $citations,
        'references' => $referenceTexts,
        'matches'    => $matches,
        'meta'       => [
            'title' => $lib->title, 'author' => $lib->author, 'year' => (string) $lib->year,
            'journal' => $lib->journal, 'doi' => $lib->doi, 'license' => $lib->license,
        ],
        // Markdown / front-matter syntax that reached the body as text.
        'leftovers'  => $leftovers,
    ];
}

test('a vault survives export → re-import → export → re-import', function (string $flavor) {
    Queue::fake();
    [$user, $citing, $cited] = vrtSeedOriginals();
    $original = [$citing => vrtFingerprint($citing), $cited => vrtFingerprint($cited)];

    // ── Generation 1: the vault, dropped back in ────────────────────────────
    $vault = vrtExport($user, [$citing, $cited], $flavor);
    expect($vault)->toHaveKeys([$citing, $cited]);
    $gen1 = [
        $citing => vrtImport($user, $vault[$citing], $citing),
        $cited  => vrtImport($user, $vault[$cited], $cited),
    ];
    $one = [$citing => vrtFingerprint($gen1[$citing]), $cited => vrtFingerprint($gen1[$cited])];

    // The citing book: same prose, same notes, same references, same links.
    expect($one[$citing]['leftovers'])->toBe([]);
    expect($one[$citing]['body'])->toBe($original[$citing]['body']);
    expect($one[$citing]['references'])->toBe($original[$citing]['references']);
    // DECLARED (Zettlr only): Zettlr has no paragraph anchor, so a citation
    // whose reference has no note, DOI or URL to point at is exported as plain
    // text — and "; Beck 1992)" following a link is not re-linked on import.
    expect($one[$citing]['citations'])->toBe($flavor === MarkdownVaultBuilder::FLAVOR_ZETTLR
        ? ['2020 → Harvey, David. 2020. Anti-Capitalist Politics. London: Pluto Press.']
        : $original[$citing]['citations']);
    expect($one[$citing]['meta'])->toBe($original[$citing]['meta']);
    // What was matched and verified on the original is true of its copy.
    expect($one[$citing]['matches'])->toBe($original[$citing]['matches']);
    // DECLARED: the hypercite arrow is now a third footnote holding the citation.
    expect($one[$citing]['footnotes'])->toHaveCount(3);
    expect(array_slice($one[$citing]['footnotes'], 0, 2))->toBe($original[$citing]['footnotes']);
    expect($one[$citing]['footnotes'][2])->toHaveCount(1);
    expect($one[$citing]['footnotes'][2][0])->toContain('David Harvey')->toContain('Anti-Capitalist Politics');
    // A footnote keeps its shape: a paragraph, then the quotation as a quotation.
    expect($one[$citing]['footnotes'][1])->toBe([
        'p: As one account has it:',
        'blockquote: the commons is about how groups of people can work together',
    ]);

    // The cited book. DECLARED: the editor-inserted citation's reference is
    // now a "References" section in the body, and the importer links it.
    expect($one[$cited]['leftovers'])->toBe([]);
    expect($one[$cited]['body'])->toBe(array_merge($original[$cited]['body'], [
        'References',
        'Marx, Karl. 1867. Capital: A Critique of Political Economy. Hamburg: Otto Meissner.',
    ]));
    expect($one[$cited]['references'])->toBe($original[$cited]['references']);
    expect($one[$cited]['citations'])->toBe(['1867 → Marx, Karl. 1867. Capital: A Critique of Political Economy. Hamburg: Otto Meissner.']);
    expect($one[$cited]['meta'])->toBe($original[$cited]['meta']);
    // Its reference id was re-minted (Ref… → marx1867), so the match is carried by the
    // reference's TEXT — and still names the same book, still verified.
    expect($one[$cited]['matches'])->toBe($original[$cited]['matches']);
    expect(array_values($one[$cited]['matches'])[0])->toMatchArray(['source' => 'vrtbook_marx_capital', 'verified' => true]);

    // ── Generation 2: export the copies, drop THAT vault back in ────────────
    $vault2 = vrtExport($user, array_values($gen1), $flavor);
    $two = [];
    foreach ($gen1 as $origin => $copy) {
        $two[$origin] = vrtFingerprint(vrtImport($user, $vault2[$copy], $copy));
    }

    // A fixed point: nothing grows, nothing is lost, however often it cycles.
    if ($flavor === MarkdownVaultBuilder::FLAVOR_ZETTLR) {
        // The one thing allowed to move, and only upward: the plain-text
        // citation generation 1 could not link stands in an unbroken
        // "(Harvey 2020; Beck 1992)" this time round, which the importer links.
        expect(array_diff($one[$citing]['citations'], $two[$citing]['citations']))->toBe([]);
        expect($two[$citing]['citations'])->toBe($original[$citing]['citations']);
        unset($one[$citing]['citations'], $two[$citing]['citations']);
    }
    expect($two[$citing])->toBe($one[$citing]);
    expect($two[$cited])->toBe($one[$cited]);
})->with([
    'obsidian vault' => [MarkdownVaultBuilder::FLAVOR_OBSIDIAN],
    'zettlr vault'   => [MarkdownVaultBuilder::FLAVOR_ZETTLR],
]);

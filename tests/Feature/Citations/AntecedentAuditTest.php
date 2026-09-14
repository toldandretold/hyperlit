<?php

/**
 * `citations:audit-antecedent` — the review surface for the ONE citation resolution that guesses.
 *
 * A citation whose author is not in its parentheses is resolved by walking BACK through the
 * paragraph for the nearest name whose key exists in the bibliography. That inference can produce a
 * link to a real entry that is not the cited work, so every such link is stamped
 * `data-resolved="antecedent"` in the stored HTML and this command reads them back at corpus scale.
 *
 * What each test locks is the RANKING — the command's whole value is that a human reads the
 * doubtful end of a 900-article list instead of all of it — plus the scope rules (sub-books never
 * audited) and the flag/unflag round trip.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (afterEach admin deletes deadlock against the
 * open RefreshDatabase transaction — see docs/journal-harvest.md).
 */

use App\Models\ConversionFlag;
use Illuminate\Support\Facades\DB;

const ANTE_PREFIX = 'book_antetest_';

function anteDb()
{
    return DB::connection('pgsql_admin');
}

function anteCleanup(): void
{
    foreach (['nodes', 'library', 'conversion_flags'] as $table) {
        anteDb()->table($table)->where('book', 'LIKE', ANTE_PREFIX . '%')->delete();
    }
}

beforeEach(fn () => anteCleanup());
afterAll(fn () => anteCleanup());

function anteBook(string $suffix): string
{
    $book = ANTE_PREFIX . $suffix;
    anteDb()->table('library')->insert([
        'book'       => $book,
        'title'      => 'AnteTest ' . $suffix,
        'visibility' => 'public',
        'has_nodes'  => true,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

function anteNode(string $book, int $line, string $html): void
{
    anteDb()->table('nodes')->insert([
        'book'      => $book,
        'chunk_id'  => 0,
        'startLine' => $line,
        'content'   => $html,
        'plainText' => trim(strip_tags($html)),
        'type'      => 'p',
        'node_id'   => $book . '_' . $line,
        'footnotes' => '[]',
    ]);
}

/** An antecedent-resolved citation link, as the linker stamps it. */
function anteLink(string $target, string $year): string
{
    return '<a class="in-text-citation" data-resolved="antecedent" href="#' . $target . '">' . $year . '</a>';
}

function anteEntry(string $id, string $text): string
{
    return '<p><a class="bib-entry" id="' . $id . '"></a>' . $text . '</p>';
}

function anteRun(array $options = []): string
{
    \Illuminate\Support\Facades\Artisan::call('citations:audit-antecedent', $options);

    return \Illuminate\Support\Facades\Artisan::output();
}

test('a citation naming its author in the same sentence is the strong shape', function () {
    $book = anteBook('strong');
    anteNode($book, 1, '<p>Castells argues that mass self-communication reshapes power ('
        . anteLink('castells2009', '2009') . ', 55).</p>');
    anteNode($book, 2, anteEntry('castells2009', 'Castells, M. (2009). Communication Power.'));

    $out = anteRun(['--book' => $book]);

    expect($out)->toContain('1 antecedent-resolved link(s)')
        ->and($out)->toMatch('/in_sentence\s+1/');
});

test('a citation whose author is only in an earlier sentence is ranked cross_sentence', function () {
    $book = anteBook('cross');
    anteNode($book, 1, '<p>Similarly, Lévy anticipated the fall of dictatorships around the world. '
        . '"The destiny of democracy and cyberspace are intimately linked" argues the philosopher ('
        . anteLink('levy2002', '2002') . ': 33).</p>');
    anteNode($book, 2, anteEntry('levy2002', 'Lévy, P. (2002). Cyberdemocratie.'));

    $out = anteRun(['--book' => $book]);

    expect($out)->toMatch('/cross_sentence\s+1/')
        ->and($out)->toContain('argues the philosopher');
});

test('a rival entry sharing the year is ranked ambiguous_year, and the rival is named', function () {
    // Two entries share 2003 and both surnames appear in the paragraph, so the walk-back simply
    // took the nearer one — the reviewer needs to see the one it passed over.
    $book = anteBook('ambiguous');
    anteNode($book, 1, '<p>Salter and Wittgenstein both wrote in that decade; normative use '
        . 'determines meaning (' . anteLink('salter2003', '2003') . ': 118).</p>');
    anteNode($book, 2, anteEntry('salter2003', 'Salter, L. (2003). Democracy and the net.'));
    anteNode($book, 3, anteEntry('wittgenstein2003', 'Wittgenstein, L. (2003). Investigations.'));

    $path = storage_path('app/ante-rivals-test.md');
    @unlink($path);
    $out = anteRun(['--book' => $book, '--out' => $path]);

    expect($out)->toMatch('/ambiguous_year\s+1/');
    expect(file_get_contents($path))->toContain('rivals')->toContain('wittgenstein2003');
    @unlink($path);
});

test('a link inside a reference-entry paragraph is ranked first — a gate escaped', function () {
    $book = anteBook('refregion');
    anteNode($book, 1, '<p>Huntley, A. C. (' . anteLink('huntley1995', '1995')
        . '). Conservation Ecology: a journal for both authors and readers.</p>');
    anteNode($book, 2, anteEntry('huntley1995', 'Huntley, A. C. (1995). Conservation Ecology.'));

    $out = anteRun(['--book' => $book]);

    expect($out)->toMatch('/reference_region\s+1/');
});

test('sub-books are never audited — their citations belong to the parent', function () {
    $parent = anteBook('parent');
    anteDb()->table('library')->insert([
        'book' => $parent . '/Fn1', 'title' => 'AnteTest annotation', 'visibility' => 'public',
        'has_nodes' => true, 'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    anteNode($parent . '/Fn1', 1, '<p>An annotation citing (' . anteLink('smith2001', '2001') . ').</p>');

    $out = anteRun(['--book' => $parent . '/Fn1']);

    expect($out)->toContain('No books in scope');
});

test('a book with no antecedent links is silent about them', function () {
    $book = anteBook('clean');
    anteNode($book, 1, '<p>An ordinary citation (Ostrom <a class="in-text-citation" '
        . 'href="#ostrom1990">1990</a>) resolved from its own parentheses.</p>');

    $out = anteRun(['--book' => $book]);

    expect($out)->toContain('No antecedent-resolved links found');
});

test('--flag raises one flag per book and --unflag removes exactly those', function () {
    $book = anteBook('flagme');
    anteNode($book, 1, '<p>Similarly, Lévy anticipated much. "A quote" argues the philosopher ('
        . anteLink('levy2002', '2002') . ': 33).</p>');
    anteNode($book, 2, anteEntry('levy2002', 'Lévy, P. (2002). Cyberdemocratie.'));

    anteRun(['--book' => $book, '--flag' => true]);

    // Flags are written and deleted on the DEFAULT connection (that is what the command uses), so
    // they must be read there too — the admin connection cannot see inside RefreshDatabase's
    // transaction, which is why the seeded library/nodes above use pgsql_admin and this does not.
    $flag = DB::table('conversion_flags')->where('book', $book)->first();
    expect($flag)->not->toBeNull();
    expect($flag->details)->toContain('antecedent_citation_link');

    anteRun(['--unflag' => true]);
    expect(DB::table('conversion_flags')->where('book', $book)->exists())->toBeFalse();
});

test('an unrelated flag survives --unflag', function () {
    $book = anteBook('otherflag');
    ConversionFlag::raise($book, ConversionFlag::SOURCE_AUTO_SWEEP, 'something else entirely',
        ['issueTypes' => ['body_absent']]);

    anteRun(['--unflag' => true]);

    expect(DB::table('conversion_flags')->where('book', $book)->exists())->toBeTrue();
});

test('--out writes a review document carrying the sentence and the resolved entry', function () {
    $book = anteBook('outfile');
    anteNode($book, 1, '<p>Similarly, Lévy anticipated the fall of dictatorships. "A quote here" '
        . 'argues the philosopher (' . anteLink('levy2002', '2002') . ': 33).</p>');
    anteNode($book, 2, anteEntry('levy2002', 'Lévy, P. (2002). Cyberdemocratie.'));

    $path = storage_path('app/ante-review-test.md');
    @unlink($path);
    anteRun(['--book' => $book, '--out' => $path]);

    expect(file_exists($path))->toBeTrue();
    $doc = file_get_contents($path);
    expect($doc)->toContain('levy2002')
        ->and($doc)->toContain('argues the philosopher')
        ->and($doc)->toContain($book);
    @unlink($path);
});

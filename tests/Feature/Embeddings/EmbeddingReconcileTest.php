<?php

/**
 * Embedding lifecycle — the 2026-08 audit fixes.
 *
 * Locks three behaviours:
 *   1. embeddings:reconcile dispatches QueueBookEmbeddings for eligible books
 *      with missing embeddings, and NOT for generated/synthetic books.
 *   2. embeddings:reconcile scrubs stray vectors from ineligible books while
 *      leaving eligible books' vectors alone.
 *   3. The editor bulk upsert NULLs a node's embedding when its content
 *      changes (so the book-level job re-embeds it) and keeps it when the
 *      content is unchanged — the "edited nodes keep pre-edit vectors
 *      forever" staleness bug.
 *   4. NODE-level eligibility: reference matter (bibliography entries and
 *      footnote definitions) is never embedded, while the inline markers that
 *      merely LOOK similar stay embedded. See EmbeddingEligibility.
 *
 * Inserts go through pgsql_admin (RLS bypass — see RetrievalScopeTest note);
 * fixtures use the 'book_embtest_' prefix and are wiped per-test since the
 * admin connection isn't covered by the test transaction.
 */

use App\Jobs\GenerateNodeEmbedding;
use App\Jobs\QueueBookEmbeddings;
use App\Models\User;
use App\Services\EmbeddingEligibility;
use App\Services\EmbeddingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function embAdminDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    embAdminDb()->table('nodes')->whereRaw("book LIKE 'book_embtest_%'")->delete();
    embAdminDb()->table('library')->whereRaw("book LIKE 'book_embtest_%'")->delete();
    embAdminDb()->table('users')->whereRaw("email LIKE '%@embtest.test'")->delete();
});

function embSeedBook(array $opts): string
{
    $book = $opts['book'] ?? ('book_embtest_' . Str::random(8));
    embAdminDb()->table('library')->insert([
        'book' => $book,
        'title' => $opts['title'] ?? 'Embedding test book',
        'author' => 'Tester',
        'creator' => $opts['creator'] ?? 'embtester',
        'visibility' => $opts['visibility'] ?? 'public',
        'listed' => true,
        'type' => $opts['type'] ?? 'book',
        'has_nodes' => true,
        'raw_json' => $opts['raw_json'] ?? '[]',
        'timestamp' => 0,
    ]);

    embAdminDb()->table('nodes')->insert([
        'book' => $book,
        'chunk_id' => 0,
        'startLine' => 100,
        'node_id' => $book . '_node_1',
        'content' => '<p>' . ($opts['text'] ?? 'a paragraph with plenty of embedding-worthy text in it') . '</p>',
        'plainText' => $opts['text'] ?? 'a paragraph with plenty of embedding-worthy text in it',
        'embedding' => ($opts['withEmbedding'] ?? false)
            ? embAdminDb()->raw("'[" . implode(',', array_fill(0, 768, 0.1)) . "]'::halfvec")
            : null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

/**
 * Add one extra node to an existing book. $opts: content, plainText (defaults
 * to content stripped of tags), withEmbedding, startLine.
 */
function embSeedNode(string $book, array $opts): string
{
    $nodeId = $book . '_node_' . Str::random(6);
    $content = $opts['content'];

    embAdminDb()->table('nodes')->insert([
        'book' => $book,
        'chunk_id' => 0,
        'startLine' => $opts['startLine'] ?? 200,
        'node_id' => $nodeId,
        'content' => $content,
        'plainText' => $opts['plainText'] ?? trim(strip_tags($content)),
        'embedding' => ($opts['withEmbedding'] ?? false)
            ? embAdminDb()->raw("'[" . implode(',', array_fill(0, 768, 0.1)) . "]'::halfvec")
            : null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $nodeId;
}

/** Ask the SQL predicate (not the PHP twin) whether a stored node is eligible. */
function embSqlEligible(string $nodeId): bool
{
    return embAdminDb()
        ->table('nodes')
        ->where('node_id', $nodeId)
        ->whereRaw(EmbeddingEligibility::nodeSql('nodes'))
        ->exists();
}

/**
 * Every shape that means "this node IS reference matter", and — just as
 * important — the near-miss shapes that must stay embedded.
 *
 * Asserted against BOTH implementations, because there are two: the SQL
 * predicate and its PHP twin. They cannot share a regex (Postgres spells the
 * word boundary `\y`; PCRE spells it `\b`, and `\b` in Postgres means
 * BACKSPACE, so a copy-pasted pattern silently matches nothing). A shape that
 * disagrees across the two means the per-node job and the reconcile sweep
 * fight each other forever: one embeds, the other scrubs.
 */
dataset('reference shapes', [
    'paste footnotes section' => [
        '<p data-static-content="footnotes" id="11400">21. Mannathukkaren, <em>Communism, Subaltern Studies and Postcolonial Theory</em>, pp. 178-179.</p>',
        false,
    ],
    'paste bibliography section' => [
        '<p data-static-content="bibliography">Arendt, H. (1958) The Human Condition. Chicago, IL: University of Chicago Press.</p>',
        false,
    ],
    'python bib-entry anchor' => [
        '<p id="4500"><a class="bib-entry" id="arendt1958"></a>Arendt, H. (1958) The Human Condition. Chicago, IL: University of Chicago Press.</p>',
        false,
    ],
    // The JATS shape puts the class on the <p> itself. A literal
    // '<a class="bib-entry"' match misses it — the bug called out in
    // citation_link_rules.py and run_regression.py.
    'JATS bib-entry on the paragraph' => [
        '<p id="CR1" class="bib-entry">Smith J (1970) On the origins of something or other. Journal of Things 4: 1-20.</p>',
        false,
    ],
    'legacy bib-entry div' => [
        '<div class="bib-entry">Ackoff, R. L. (1981) Creating the Corporate Future. New York. Wiley.</div>',
        false,
    ],
    'footnote definition anchor' => [
        '<p id="17"><a fn-count-id="12" id="Fn1789822382142_0001"></a>12. An exception is Caroline Thomas, who argued the opposite at some length.</p>',
        false,
    ],
    'unconverted markdown footnote definition' => [
        '<p>[^286]: Note that the term digitality has been used in a different sense by other authors.</p>',
        false,
    ],
    // ---- everything below must STAY embedded ----
    // 269k nodes carry this. `footnote-ref` contains the word `footnote`, so a
    // substring class match here deletes a quarter of the corpus.
    'inline footnote marker in prose' => [
        '<p>Accumulation proceeds by dispossession<sup class="footnote-ref" fn-count-id="12" id="ref12">12</sup> across the colonial periphery.</p>',
        true,
    ],
    'inline citation anchor in prose' => [
        '<p>As <a class="in-text-citation" href="#arendt1958">Arendt (1958)</a> argues, labour and work are not the same thing.</p>',
        true,
    ],
    // The extractor wrongly mints bib-entry anchors inside figure captions;
    // the caption is real prose about a photograph.
    'figure caption carrying a stray bib-entry anchor' => [
        '<figure id="99500"><img alt="" src="/x.jpg"/><figcaption><p><a class="bib-entry" id="ccf1954"></a>Aerial photograph of the 1950 CCF conference in Berlin, which reveals its scale.</p></figcaption></figure>',
        true,
    ],
    // Reads like an endnote, is an ordinary list item. Numeric prefixes are
    // deliberately not part of the predicate.
    'numbered prose that merely looks like an endnote' => [
        "<p>4. At the offline 'Citizen's Budget Festival', citizens can discuss and choose projects together.</p>",
        true,
    ],
    'ordinary paragraph' => [
        '<p>The rate of profit falls as the organic composition of capital rises over time.</p>',
        true,
    ],
]);

it('classifies reference matter identically in SQL and PHP', function (string $content, bool $expectedEligible) {
    $book = embSeedBook([]);
    $nodeId = embSeedNode($book, ['content' => $content]);
    $node = embAdminDb()->table('nodes')->where('node_id', $nodeId)->first();

    expect(EmbeddingEligibility::nodeEligible($node))->toBe($expectedEligible)
        ->and(embSqlEligible($nodeId))->toBe($expectedEligible);
})->with('reference shapes');

it('reconcile scrubs vectors from reference nodes and keeps neighbouring prose', function () {
    Queue::fake();

    $book = embSeedBook(['withEmbedding' => true]); // prose node, embedded
    $bib = embSeedNode($book, [
        'content' => '<p><a class="bib-entry" id="arendt1958"></a>Arendt, H. (1958) The Human Condition. Chicago, IL: University of Chicago Press.</p>',
        'withEmbedding' => true,
        'startLine' => 200,
    ]);
    $footnote = embSeedNode($book, [
        'content' => '<p data-static-content="footnotes">21. Mannathukkaren, Communism, Subaltern Studies and Postcolonial Theory, pp. 178-179.</p>',
        'withEmbedding' => true,
        'startLine' => 300,
    ]);

    $this->artisan('embeddings:reconcile')->assertSuccessful();

    expect(embAdminDb()->table('nodes')->where('node_id', $bib)->whereNotNull('embedding')->count())->toBe(0)
        ->and(embAdminDb()->table('nodes')->where('node_id', $footnote)->whereNotNull('embedding')->count())->toBe(0)
        // the book's original prose node keeps its vector
        ->and(embAdminDb()->table('nodes')->where('node_id', $book . '_node_1')->whereNotNull('embedding')->count())->toBe(1);
});

it('QueueBookEmbeddings dispatches only the prose nodes', function () {
    Queue::fake();

    $book = embSeedBook([]); // prose, no embedding
    embSeedNode($book, [
        'content' => '<p><a class="bib-entry" id="arendt1958"></a>Arendt, H. (1958) The Human Condition. Chicago, IL: University of Chicago Press.</p>',
        'startLine' => 200,
    ]);

    (new QueueBookEmbeddings($book))->handle();

    Queue::assertPushed(GenerateNodeEmbedding::class, 1);
});

it('GenerateNodeEmbedding refuses to embed a reference node', function () {
    // If this fails, the job is still using its own inline length check rather
    // than the shared definition — it would re-embed whatever reconcile scrubs.
    $this->mock(EmbeddingService::class)->shouldNotReceive('embed');

    $book = embSeedBook([]);
    $nodeId = embSeedNode($book, [
        'content' => '<p data-static-content="bibliography">Arendt, H. (1958) The Human Condition. Chicago, IL: University of Chicago Press.</p>',
        'startLine' => 200,
    ]);
    $rowId = embAdminDb()->table('nodes')->where('node_id', $nodeId)->value('id');

    app()->call([new GenerateNodeEmbedding($rowId), 'handle']);

    expect(embAdminDb()->table('nodes')->where('node_id', $nodeId)->whereNotNull('embedding')->count())->toBe(0);
});

it('reconcile dispatches for eligible books with missing embeddings, not for synthetic books', function () {
    Queue::fake();

    $eligible = embSeedBook([]);
    $private = embSeedBook(['visibility' => 'private']);
    $shelf = embSeedBook(['raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => 'x', 'sort' => 'recent'])]);
    $userHome = embSeedBook(['raw_json' => json_encode(['type' => 'user_home', 'username' => 'embtester'])]);
    $report = embSeedBook(['type' => 'report']);
    $covered = embSeedBook(['withEmbedding' => true]);

    $this->artisan('embeddings:reconcile')->assertSuccessful();

    Queue::assertPushed(QueueBookEmbeddings::class, function ($job) use ($eligible) {
        return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $eligible;
    });
    Queue::assertPushed(QueueBookEmbeddings::class, function ($job) use ($private) {
        return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $private;
    });
    foreach ([$shelf, $userHome, $report, $covered] as $notExpected) {
        Queue::assertNotPushed(QueueBookEmbeddings::class, function ($job) use ($notExpected) {
            return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $notExpected;
        });
    }
});

it('reconcile scrubs stray embeddings on ineligible books and keeps eligible ones', function () {
    Queue::fake();

    $eligible = embSeedBook(['withEmbedding' => true]);
    $shelf = embSeedBook(['withEmbedding' => true, 'raw_json' => json_encode(['type' => 'shelf'])]);
    $report = embSeedBook(['withEmbedding' => true, 'type' => 'report']);

    $this->artisan('embeddings:reconcile')->assertSuccessful();

    expect(embAdminDb()->table('nodes')->where('book', $eligible)->whereNotNull('embedding')->count())->toBe(1)
        ->and(embAdminDb()->table('nodes')->where('book', $shelf)->whereNotNull('embedding')->count())->toBe(0)
        ->and(embAdminDb()->table('nodes')->where('book', $report)->whereNotNull('embedding')->count())->toBe(0);
});

it('bulk upsert NULLs the embedding when content changes and keeps it when unchanged', function () {
    Queue::fake();

    // Seed via admin — the default connection's RLS blocks raw user inserts
    // in tests (no HTTP middleware to set the session vars)
    $name = 'embtester_' . Str::random(6);
    $userId = embAdminDb()->table('users')->insertGetId([
        'name' => $name,
        'email' => Str::random(8) . '@embtest.test',
        'password' => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $user = User::on('pgsql_admin')->find($userId);
    $book = embSeedBook(['creator' => $user->name, 'withEmbedding' => true]);
    $nodeId = $book . '_node_1';

    $payload = fn (string $content) => [
        'book' => $book,
        'data' => [[
            'book' => $book,
            'node_id' => $nodeId,
            'startLine' => 100,
            'chunk_id' => 0,
            'content' => $content,
            'footnotes' => [],
            'type' => 'p',
        ]],
    ];

    // Assert via the DEFAULT connection: the endpoint writes inside this
    // test's uncommitted transaction, which the admin connection can't see
    // (same gotcha as EncryptionTransitionTest).

    // Unchanged content → vector survives. NB the content string must match
    // the stored one byte-for-byte (it round-trips the sanitizer).
    $stored = embAdminDb()->table('nodes')->where('node_id', $nodeId)->value('content');
    $this->actingAs($user)->postJson('/api/db/nodes/bulk-create', $payload($stored))->assertOk();
    expect(DB::table('nodes')->where('node_id', $nodeId)->whereNotNull('embedding')->count())->toBe(1);

    // Changed content → vector NULLed (the book-level job then re-embeds)
    $this->actingAs($user)->postJson('/api/db/nodes/bulk-create', $payload('<p>a completely different paragraph of text</p>'))->assertOk();
    expect(DB::table('nodes')->where('node_id', $nodeId)->whereNotNull('embedding')->count())->toBe(0);

    // And the path still dispatches the re-embed job
    Queue::assertPushed(QueueBookEmbeddings::class);
});

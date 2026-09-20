<?php

namespace App\Services\CitationReview\Phases;

use App\Services\CitationReview\Support\SearchTerms;
use App\Services\EmbeddingEligibility;
use App\Services\EmbeddingService;
use App\Services\SearchService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Phase 4 of the citation review: for each claim whose source has in-app
 * content, find the passages in that source most relevant to the claim.
 * Mutates each claim's 'source_passages' in place.
 *
 * Four-strategy escalation: a 3-step Postgres FTS ladder (verbatim AND →
 * key-term OR → simple-config OR), then SEMANTIC search over the source
 * book's node embeddings when every lexical strategy comes up empty. The
 * semantic rung exists because FTS is stem-bound: a claim saying "enslaving"
 * never matches a source saying "slaves" (stems enslav/slave), which is how
 * the passage that PROVED chacko c128's citation was missed while sitting in
 * the source book. Embeddings are generated on their own queue lane, so a
 * source fetched mid-review may not be embedded yet — those are embedded
 * here in the pooled between-pass round (see searchSourcePassages), larger
 * ones fall through silently.
 */
final class PassageSearcher
{
    /**
     * Below this cosine similarity a "best" semantic hit is noise, not
     * evidence. Calibrated on the real chacko c128 source: the proving
     * passage scored 0.73 while UNRELATED paragraphs of the same document
     * sat at ~0.67 — this model's in-document noise floor is high, so an
     * absolute floor mostly guards against empty/degenerate matches and the
     * ORDERING does the real work (the right passage ranked 1 of 58).
     */
    private const MIN_SEMANTIC_SIMILARITY = 0.55;

    /**
     * A best FTS ts_rank below this is a stopword-grade match, not evidence —
     * chacko c128's full text returned rank ~0.005 passages that matched on
     * little more than "India" while the proving passage (zero stem overlap:
     * "enslaving" vs "slaves") wasn't in the top 3. Weak lexical results get
     * the semantic pass too, with semantic hits ranked first.
     */
    private const WEAK_FTS_RANK = 0.02;

    /**
     * A source with no embeddings yet gets them inline when it is at most
     * this many nodes. Sized for the books young enough to have beaten the
     * embeddings queue lane (which backlogs tens of thousands of jobs):
     * web_* fetch stubs (~15-60 nodes) and freshly converted JOURNAL
     * ARTICLES (~100-400 nodes). Costs a few seconds once per source, inside
     * a pipeline phase that runs minutes. Multi-thousand-node monographs
     * stay queue-only — they are almost always old library books that were
     * embedded long ago, and semantic search runs over whatever subset IS
     * embedded anyway.
     */
    private const INLINE_EMBED_MAX_NODES = 400;

    /** Texts per provider request — embedBatch does NOT chunk internally. */
    private const INLINE_EMBED_BATCH_SIZE = 100;

    public function __construct(
        private SearchTerms $searchTerms,
        private EmbeddingService $embeddings,
    ) {}

    /**
     * Two-pass flow: the claim loop never waits on the provider, and every
     * embedding request — document chunks AND query texts — flies in ONE
     * concurrent pooled round (Http::pool; the provider parallelises, PHP
     * just holds the sockets).
     *
     * PASS 1 walks every claim through the lexical ladder only. Strong FTS =
     * done — that source is never embedded at all. Weak/empty = parked.
     *
     * BETWEEN passes: needy sources (parked, zero embeddings, ≤400 nodes,
     * advisory-locked) contribute document batches; every parked claim
     * contributes its query text, batched ~100 per request. One
     * poolEmbedBatches round resolves them all concurrently — N needy
     * sources cost ~one round-trip, not N.
     *
     * PASS 2 sweeps the parked claims with pgvector searches (pure DB, fast)
     * using the pooled query vectors. Books too big to embed inline benefit
     * too: the background embeddings lane kept draining while the review
     * ran, so the sweep searches whatever vectors exist by then.
     */
    public function searchSourcePassages(array &$claims): void
    {
        $db = DB::connection('pgsql_admin');
        $deferred = []; // claimIdx => [bookId, searchText, raw fts rows]

        foreach ($claims as $idx => &$claim) {
            if (!$claim['has_source_content'] || !$claim['source_book_id']) {
                continue;
            }

            // Use truth_claim for search — it's the verbatim sentence with richer topical
            // keywords and no author/year attribution that would pollute FTS queries.
            // contextualised_claim is still used for LLM verification (line 547).
            $searchText = mb_substr($claim['truth_claim'], 0, 200);
            $bookId = $claim['source_book_id'];

            // Strategy 1: AND query with shorter text (catches near-verbatim matches)
            $shortText = mb_substr($searchText, 0, 80);
            $passages = $this->ftsQuery($db, $bookId, $shortText, 'english', 'plainto_tsquery');

            // Strategy 2: OR query with key terms (catches thematic matches)
            if (empty($passages)) {
                $orTerms = $this->searchTerms->orSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'english', 'websearch_to_tsquery');
                }
            }

            // Strategy 3: Simple config OR fallback
            if (empty($passages)) {
                $orTerms = $orTerms ?? $this->searchTerms->orSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'simple', 'websearch_to_tsquery');
                }
            }

            // Strategy 4 candidate: lexical miss (stem/synonym gaps —
            // "enslaving" never FTS-matches "slaves") or stopword-grade
            // matches only. Parked for the pooled semantic sweep.
            $bestFtsRank = empty($passages) ? 0.0 : (float) $passages[0]->rank;
            if (empty($passages) || $bestFtsRank < self::WEAK_FTS_RANK) {
                $deferred[$idx] = [$bookId, $searchText, $passages];
            }

            $claim['source_passages'] = $this->mapPassages($passages);
        }
        unset($claim);

        if ($deferred === []) {
            return;
        }

        try {
            $this->semanticSweep($db, $claims, $deferred);
        } catch (\Throwable $e) {
            // Semantic is an enhancement rung: a failure here must never take
            // down the phase — the claims keep their lexical results.
            Log::warning('PassageSearcher semantic sweep failed', [
                'error' => mb_substr($e->getMessage(), 0, 200),
            ]);
        }
    }

    /**
     * The between-pass pooled round + pass 2. Locks are held only across the
     * pool call and the vector writes, and always released.
     */
    private function semanticSweep($db, array &$claims, array $deferred): void
    {
        $batches = [];    // pool key => texts
        $docPlan = [];    // bookId => ['nodes' => Collection, 'keys' => [pool keys]]
        $lockedBooks = [];

        try {
            // Document batches: parked books with no vectors yet.
            foreach (array_unique(array_column($deferred, 0)) as $bookId) {
                $embedded = (int) $db->table('nodes')
                    ->where('book', $bookId)->whereNotNull('embedding')->count();
                if ($embedded > 0 || !$this->lockForEmbedding($db, $bookId, $lockedBooks)) {
                    continue;
                }
                $plan = $this->docBatchPlan($db, $bookId, $batches);
                if ($plan !== null) {
                    $docPlan[$bookId] = $plan;
                }
            }

            // Query batches: every parked claim's search text, ~100 per request.
            $queryKeys = []; // claimIdx => [pool key, offset]
            $chunk = [];
            $chunkIdx = 0;
            foreach ($deferred as $idx => [, $searchText]) {
                $queryKeys[$idx] = ["q|{$chunkIdx}", count($chunk)];
                $chunk[] = 'search_query: ' . $searchText;
                if (count($chunk) >= self::INLINE_EMBED_BATCH_SIZE) {
                    $batches["q|{$chunkIdx}"] = $chunk;
                    $chunk = [];
                    $chunkIdx++;
                }
            }
            if ($chunk !== []) {
                $batches["q|{$chunkIdx}"] = $chunk;
            }

            // ONE concurrent round for everything.
            $results = $this->embeddings->poolEmbedBatches($batches);

            foreach ($docPlan as $bookId => $plan) {
                $this->writeDocVectors($db, $plan, $results);
            }
        } finally {
            foreach ($lockedBooks as $bookId) {
                $db->selectOne("SELECT pg_advisory_unlock(hashtext(?))", ['passage_embed:' . $bookId]);
            }
        }

        // Pass 2: pure pgvector searches with the pooled query vectors.
        foreach ($deferred as $idx => [$bookId, , $ftsRows]) {
            [$key, $offset] = $queryKeys[$idx];
            $vector = $results[$key][$offset] ?? null;
            if (!$vector) {
                continue;
            }
            $semantic = $this->semanticSearchByVector($db, $bookId, $vector);
            if (!empty($semantic)) {
                $claims[$idx]['source_passages'] = $this->mapPassages(
                    $this->mergeSemanticFirst($semantic, $ftsRows)
                );
            }
        }
    }

    /** Semantic hits lead; weak lexical hits fill the tail (dedupe, cap 3). */
    private function mergeSemanticFirst(array $semantic, array $ftsRows): array
    {
        if (empty($semantic)) {
            return $ftsRows;
        }
        $seen = [];
        $merged = [];
        foreach (array_merge($semantic, $ftsRows) as $row) {
            if (isset($seen[$row->node_id])) {
                continue;
            }
            $seen[$row->node_id] = true;
            $merged[] = $row;
        }
        return array_slice($merged, 0, 3);
    }

    /** @return array[] the claim-facing passage shape */
    private function mapPassages(array $passages): array
    {
        return array_map(function($p) {
                // The FTS expression indexes cover plainText only (the
                // replace_stored_tsvectors migration backfilled it for
                // legacy HTML-only rows), but keep the content fallback for
                // DISPLAY robustness: if a row somehow has empty plainText,
                // better a stripped-content excerpt than an empty one.
                $plain = trim($p->plainText ?? '');
                $text = $plain !== ''
                    ? $p->plainText
                    : html_entity_decode(strip_tags($p->content ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                $text = $text ?? '';
                $truncated = mb_strlen($text) > 1500;
                return [
                    'node_id' => $p->node_id,
                    'text'    => mb_substr($text, 0, 1500) . ($truncated ? "\n[...TRUNCATED]" : ''),
                    'rank'    => round($p->rank, 4),
                ];
            }, $passages);
    }

    /**
     * Run a full-text search query against the nodes table.
     */
    private function ftsQuery($db, string $bookId, string $query, string $config, string $queryFn): array
    {
        $tsExpr = SearchService::nodeTsExpression($config);

        return $db->select(
            "SELECT node_id, \"plainText\", content,
                    ts_rank({$tsExpr}, {$queryFn}('{$config}', ?)) AS rank
             FROM nodes
             WHERE book = ? AND {$tsExpr} @@ {$queryFn}('{$config}', ?)
             ORDER BY rank DESC LIMIT 3",
            [$query, $bookId, $query]
        );
    }

    /**
     * Cosine search over the source book's node embeddings with a
     * PRECOMPUTED query vector (pure DB — the vector came from the pooled
     * round). rank is the similarity (1 - distance).
     *
     * @return object[] rows shaped like ftsQuery's (node_id, plainText, content, rank)
     */
    private function semanticSearchByVector($db, string $bookId, array $vector): array
    {
        $vectorStr = '[' . implode(',', $vector) . ']';

        $rows = $db->select(
            "SELECT node_id, \"plainText\", content,
                    1 - (embedding <=> ?::halfvec) AS rank
             FROM nodes
             WHERE book = ? AND embedding IS NOT NULL
             ORDER BY embedding <=> ?::halfvec
             LIMIT 3",
            [$vectorStr, $bookId, $vectorStr]
        );

        return array_values(array_filter(
            $rows,
            fn ($row) => (float) $row->rank >= self::MIN_SEMANTIC_SIMILARITY
        ));
    }

    /**
     * Take the per-book advisory lock that makes concurrent reviews embed a
     * shared source exactly once. try-lock, never wait — the loser's claims
     * simply keep their lexical results this run; the winner's vectors are
     * there for the next. Acquired locks are recorded for the caller's
     * finally-release.
     */
    private function lockForEmbedding($db, string $bookId, array &$lockedBooks): bool
    {
        $lock = $db->selectOne(
            "SELECT pg_try_advisory_lock(hashtext(?)) AS ok",
            ['passage_embed:' . $bookId]
        );
        if (!($lock->ok ?? false)) {
            return false;
        }
        $lockedBooks[] = $bookId;
        // Double-check under the lock: the previous holder may have embedded
        // the book between our count and our lock.
        if ((int) $db->table('nodes')->where('book', $bookId)->whereNotNull('embedding')->count() > 0) {
            return false;
        }
        return true;
    }

    /**
     * Plan a needy book's document batches into the pool: eligibility via
     * the shared definition, cap at ~journal-article size (multi-thousand-
     * node monographs stay queue-only — they are almost always old library
     * books that were embedded long ago), ~100 texts per request because the
     * provider gets ONE HTTP request per batch.
     *
     * @param array<string, string[]> $batches mutated: pool key => texts
     * @return array{nodes: \Illuminate\Support\Collection, keys: string[]}|null
     */
    private function docBatchPlan($db, string $bookId, array &$batches): ?array
    {
        $total = (int) $db->table('nodes')->where('book', $bookId)->count();
        if ($total === 0 || $total > self::INLINE_EMBED_MAX_NODES) {
            return null;
        }
        $library = $db->table('library')->where('book', $bookId)->first();
        if (!EmbeddingEligibility::bookEligible($library, $bookId)) {
            return null;
        }

        $nodes = $db->table('nodes')->where('book', $bookId)
            ->whereNull('embedding')->get(['id', 'plainText'])
            ->filter(fn ($n) => strlen(trim((string) $n->plainText)) >= 20)
            ->values();
        if ($nodes->isEmpty()) {
            return null;
        }

        $keys = [];
        foreach ($nodes->chunk(self::INLINE_EMBED_BATCH_SIZE) as $i => $chunk) {
            $key = "doc|{$bookId}|{$i}";
            $batches[$key] = $chunk->map(fn ($n) => 'search_document: ' . $n->plainText)->values()->all();
            $keys[] = $key;
        }
        return ['nodes' => $nodes, 'keys' => $keys];
    }

    /**
     * Persist a book's pooled document vectors. Same discipline as
     * GenerateNodeEmbedding: the UPDATE re-checks encryption in the statement
     * so a plaintext-derived vector can never land on a book that turned
     * encrypted mid-flight (docs/e2ee.md).
     */
    private function writeDocVectors($db, array $plan, array $results): void
    {
        $vectors = [];
        foreach ($plan['keys'] as $key) {
            foreach ($results[$key] ?? [] as $vector) {
                $vectors[] = $vector;
            }
        }
        foreach ($plan['nodes'] as $i => $node) {
            $vector = $vectors[$i] ?? null;
            if (!$vector) {
                continue;
            }
            $vectorStr = '[' . implode(',', $vector) . ']';
            $db->table('nodes')
                ->where('id', $node->id)
                ->whereRaw('NOT EXISTS (SELECT 1 FROM library l WHERE l.book = nodes.book AND COALESCE(l.encrypted, false))')
                ->update(['embedding' => DB::raw("'{$vectorStr}'::halfvec")]);
        }
    }
}

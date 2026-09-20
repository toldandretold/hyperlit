<?php

namespace App\Jobs;

use App\Services\EmbeddingService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class GenerateNodeEmbedding implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $backoff = 30;

    /**
     * Skip when the node ALREADY has an embedding by the time the job runs.
     * Declared with a default (not just a constructor default) so payloads
     * queued before this property existed unserialize to false, keeping the
     * old overwrite behaviour.
     *
     * Two dispatchers, opposite needs: QueueBookEmbeddings backfills nodes
     * that had NO embedding at fan-out time — but another writer can beat the
     * queue to it (PassageSearcher inline-embeds small web sources mid-review
     * because this lane drains on its own schedule), and re-embedding then is
     * one wasted API call per node. The PgNode::saved hook, by contrast,
     * fires because plainText CHANGED — the existing vector is STALE and must
     * be overwritten, so it dispatches without the flag.
     */
    private bool $skipIfPresent = false;

    public function __construct(
        private int $nodeId,
        bool $skipIfPresent = false,
    ) {
        $this->skipIfPresent = $skipIfPresent;
        // Run on a dedicated queue so bulk embedding generation (one job per node —
        // thousands for a large book) can never sit in front of imports/reconverts
        // on the 'imports'/'default' lanes. Mirrors the citation-pipeline jobs.
        $this->onQueue('embeddings');
    }

    public function handle(EmbeddingService $embeddingService): void
    {
        // pgsql_admin (BYPASSRLS) throughout: queue workers have no RLS session
        // context, so on the default connection PRIVATE books' nodes/library rows
        // are invisible — this job silently no-op'd for every private book (found
        // 2026-06-12: 0 of 1.5M private-book nodes embedded vs 27k public). The
        // UPDATE must be admin too, or the write itself is RLS-blocked.
        $admin = DB::connection('pgsql_admin');

        $node = $admin->table('nodes')->where('id', $this->nodeId)->first();

        if (!$node || empty($node->plainText)) {
            return;
        }

        if ($this->skipIfPresent && $node->embedding !== null) {
            return; // someone (inline embed, an earlier run) got here first
        }

        // Skip very short text (not useful for embedding)
        if (strlen(trim($node->plainText)) < 20) {
            return;
        }

        // One shared eligibility definition (sub-books, E2EE, system and
        // generated card-list books, deleted) — see EmbeddingEligibility.
        $library = $admin->table('library')
            ->where('book', $node->book)
            ->first();

        if (!\App\Services\EmbeddingEligibility::bookEligible($library, $node->book)) {
            return;
        }

        $embedding = $embeddingService->embed($node->plainText);

        if ($embedding) {
            // The write re-checks encryption IN the statement: the eligibility
            // check above runs before a slow (up to 60s × retries) API call,
            // so an encrypt transition can commit — and scrub the book's
            // embeddings — while we wait. Guarding the UPDATE itself closes
            // that race; a plaintext-derived vector must never land on an
            // encrypted book after the scrub (docs/e2ee.md).
            $vectorStr = '[' . implode(',', $embedding) . ']';
            $admin->table('nodes')
                ->where('id', $this->nodeId)
                ->whereRaw('NOT EXISTS (SELECT 1 FROM library l WHERE l.book = nodes.book AND COALESCE(l.encrypted, false))')
                ->update(['embedding' => DB::raw("'{$vectorStr}'::halfvec")]);
        }
    }
}

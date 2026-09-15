<?php

namespace App\Services\Citations;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The ledger for the pipeline's AMBIGUOUS citation resolutions — where a converter's question
 * meets a human's answer, and where that answer survives reconversion.
 *
 * The converter's antecedent walk-back sometimes finds MORE THAN ONE bibliography entry that fits
 * a bare-year citation. Since 2026-09 it stops pretending to know: it links the best candidate but
 * stamps the anchor `data-resolved="ambiguous"` + `data-candidates="a|b"`. This service is the
 * other half of that contract:
 *
 *   sync($book)     after every import/reconvert — scan the fresh nodes for ambiguous anchors,
 *                   RE-APPLY any answer a human already gave (the answer lives here, not in the
 *                   HTML, precisely so a reconvert can't destroy it), and record the still-open
 *                   ones as pending rows for /maintainer/citations.
 *
 *   resolve($id)    the maintainer's answer — rewrite the anchor in the stored node (choose an
 *                   entry, or unlink it as "not a citation"), mark the row resolved, and bump the
 *                   library timestamp so open readers refetch.
 *
 * Identity across reconverts is a FINGERPRINT — sha1(book | year | folded sentence head) — because
 * node ids are minted fresh every conversion. When a pipeline fix changes the sentence itself the
 * fingerprint breaks, and that is the honest outcome: the citation surfaces as pending again and a
 * human re-answers against the new text.
 *
 * Everything here runs on pgsql_admin: sync() is called from a queue worker (no RLS session — a
 * default-connection write silently no-ops, the twice-shipped worker-RLS bug), and resolve() is
 * admin-gated at the route.
 */
class AmbiguousCitationRegistry
{
    private const MARKER = 'data-resolved="ambiguous"';

    /** Matches an ambiguous citation anchor and captures href target, candidates, year. */
    private const ANCHOR_RE =
        '/<a class="in-text-citation" data-candidates="([^"]+)" data-resolved="ambiguous" href="#([^"]+)">([^<]*)<\/a>/';

    /** Alternate attribute order (bleach/BeautifulSoup serialise alphabetically, but be liberal). */
    private const ANCHOR_RE_ALT =
        '/<a class="in-text-citation" data-resolved="ambiguous" data-candidates="([^"]+)" href="#([^"]+)">([^<]*)<\/a>/';

    /* ───────────────────────────── sync ───────────────────────────── */

    /**
     * Reconcile one book's nodes with the ledger. Returns counts for logging.
     */
    public function sync(string $book): array
    {
        $db = DB::connection('pgsql_admin');

        $nodes = $db->table('nodes')->where('book', $book)
            ->where('content', 'like', '%' . self::MARKER . '%')
            ->orderBy('chunk_id')->orderBy('startLine')
            ->get(['id', 'content']);

        $resolved = $db->table('citation_resolutions')
            ->where('book', $book)->where('status', 'resolved')
            ->get()->keyBy('fingerprint');

        $seen = [];
        $applied = 0;
        $pending = 0;

        foreach ($nodes as $node) {
            $content = (string) $node->content;
            $dirty = false;

            foreach ($this->anchorsIn($content) as $anchor) {
                $fp = $this->fingerprint($book, $anchor['year'], $anchor['sentence']);
                $seen[] = $fp;

                if (isset($resolved[$fp])) {
                    // A human already answered — apply it to the fresh conversion's HTML.
                    $content = $this->applyChoice($content, $anchor, $resolved[$fp]->chosen);
                    $dirty = true;
                    $applied++;
                    continue;
                }

                // Still open: record (or refresh) the question for the maintainer list. The row
                // id must be STABLE across refreshes — the maintainer page holds it — so update
                // in place and only mint a uuid on first insert.
                $fresh = [
                    'year'         => $anchor['year'],
                    'sentence'     => $anchor['sentence'],
                    'candidates'   => json_encode($this->enrich($db, $book, $anchor['candidates'])),
                    'href_current' => $anchor['target'],
                    'updated_at'   => now(),
                ];
                $updated = $db->table('citation_resolutions')
                    ->where('book', $book)->where('fingerprint', $fp)
                    ->where('status', 'pending')
                    ->update($fresh);
                if (!$updated && !$db->table('citation_resolutions')
                        ->where('book', $book)->where('fingerprint', $fp)->exists()) {
                    $db->table('citation_resolutions')->insert($fresh + [
                        'id'          => (string) Str::uuid(),
                        'book'        => $book,
                        'fingerprint' => $fp,
                        'status'      => 'pending',
                        'created_at'  => now(),
                    ]);
                }
                $pending++;
            }

            if ($dirty) {
                $db->table('nodes')->where('id', $node->id)->update(['content' => $content]);
            }
        }

        // A pending row whose fingerprint no longer exists is a question about text this
        // conversion no longer produces — drop it (if the ambiguity survives under new text it
        // was re-inserted above under its new fingerprint). Resolved rows are never dropped:
        // they are the human record, and a future conversion may match them again.
        $stale = $db->table('citation_resolutions')
            ->where('book', $book)->where('status', 'pending')
            ->when($seen, fn ($q) => $q->whereNotIn('fingerprint', array_unique($seen)))
            ->delete();

        return ['ambiguous' => count($seen), 'applied' => $applied,
                'pending' => $pending, 'stale_dropped' => $stale];
    }

    /* ──────────────────────────── resolve ─────────────────────────── */

    /**
     * Record a human answer and rewrite the stored anchor. $chosen is a bibliography entry id,
     * or null for "this is not a citation" (the anchor is unlinked back to plain text).
     */
    public function resolve(string $id, ?string $chosen, ?string $resolvedBy = null): array
    {
        $db = DB::connection('pgsql_admin');
        $row = $db->table('citation_resolutions')->where('id', $id)->first();
        if (!$row) {
            return ['error' => 'not_found'];
        }
        $candidates = collect(json_decode($row->candidates, true) ?? [])->pluck('target')->all();
        if ($chosen !== null && !in_array($chosen, $candidates, true)) {
            // The answer must be one of the QUESTION's options — an arbitrary target here would
            // let a typo (or a stale client) mint a link the evidence never supported.
            return ['error' => 'not_a_candidate', 'candidates' => $candidates];
        }

        $patched = 0;
        $nodes = $db->table('nodes')->where('book', $row->book)
            ->where('content', 'like', '%' . self::MARKER . '%')
            ->get(['id', 'content']);
        foreach ($nodes as $node) {
            $content = (string) $node->content;
            $dirty = false;
            foreach ($this->anchorsIn($content) as $anchor) {
                $fp = $this->fingerprint($row->book, $anchor['year'], $anchor['sentence']);
                if ($fp !== $row->fingerprint) {
                    continue;
                }
                $content = $this->applyChoice($content, $anchor, $chosen);
                $dirty = true;
                $patched++;
            }
            if ($dirty) {
                $db->table('nodes')->where('id', $node->id)->update(['content' => $content]);
            }
        }

        $db->table('citation_resolutions')->where('id', $id)->update([
            'chosen'      => $chosen,
            'status'      => 'resolved',
            'resolved_by' => $resolvedBy,
            'resolved_at' => now(),
            'updated_at'  => now(),
        ]);

        if ($patched > 0) {
            // Open readers hold the old HTML; the timestamp is the cache/stale signal they check.
            $db->table('library')->where('book', $row->book)
                ->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        return ['patched' => $patched, 'chosen' => $chosen];
    }

    /* ─────────────────────────── internals ────────────────────────── */

    /**
     * Every ambiguous anchor in one node's HTML, with the evidence needed to fingerprint and
     * patch it: raw match, target, candidates, year, and the citation's own sentence.
     */
    public function anchorsIn(string $content): array
    {
        $out = [];
        foreach ([self::ANCHOR_RE => [1, 2], self::ANCHOR_RE_ALT => [1, 2]] as $re => $order) {
            if (!preg_match_all($re, $content, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
                continue;
            }
            foreach ($m as $hit) {
                $before = strip_tags(substr($content, 0, $hit[0][1]));
                $out[] = [
                    'raw'        => $hit[0][0],
                    'candidates' => explode('|', $hit[$order[0]][0]),
                    'target'     => $hit[$order[1]][0],
                    'year'       => trim($hit[3][0]),
                    'sentence'   => $this->sentenceTail($before),
                ];
            }
        }
        return $out;
    }

    public function fingerprint(string $book, string $year, string $sentence): string
    {
        $folded = mb_strtolower(Str::ascii($sentence));
        $folded = preg_replace('/[^a-z0-9]+/', ' ', $folded);
        return sha1($book . '|' . $year . '|' . trim(mb_substr($folded, 0, 120)));
    }

    /** The citation's own sentence — the tail of the text preceding the anchor. */
    private function sentenceTail(string $before): string
    {
        $tail = trim(preg_replace('/\s+/', ' ', mb_substr($before, -400)));
        $parts = preg_split('/(?<=[.!?])\s+(?=[A-Z“"\'(])/u', $tail) ?: [$tail];
        $sentence = trim((string) end($parts));
        if (mb_strlen($sentence) < 80 && count($parts) > 1) {
            $sentence = trim($parts[count($parts) - 2] . ' ' . $sentence);
        }
        return $sentence;
    }

    /**
     * Turn the anchor's bare target ids into what a maintainer needs to decide: the entry's own
     * text and how often this book cites it PROPERLY (a target the book cites by name elsewhere
     * is far likelier to be the referent than an org/title-derived key nothing else touches).
     */
    private function enrich($db, string $book, array $targets): array
    {
        $out = [];
        foreach ($targets as $target) {
            $entryNode = $db->table('nodes')->where('book', $book)
                ->where('content', 'like', '%id="' . $target . '"%')
                ->value('content');
            $entry = null;
            if ($entryNode && preg_match(
                    '/<a class="bib-entry" id="' . preg_quote($target, '/') . '"><\/a>(.*?)<\/p>/s',
                    $entryNode, $m)) {
                $entry = trim(strip_tags($m[1]));
            }
            // Count PROPER citations of this target — anchors carrying no provenance marker,
            // i.e. resolved from their own parentheses. Per-anchor, not per-node: a node that
            // also holds an ambiguous anchor must not hide its proper ones.
            $plain = '<a class="in-text-citation" href="#' . $target . '">';
            $citedElsewhere = (int) $db->table('nodes')->where('book', $book)
                ->where('content', 'like', '%' . $plain . '%')
                ->get(['content'])
                ->sum(fn ($n) => substr_count((string) $n->content, $plain));
            $out[] = ['target' => $target, 'entry' => $entry, 'cited_elsewhere' => $citedElsewhere];
        }
        return $out;
    }

    /**
     * Rewrite one ambiguous anchor per the answer: chosen entry → a confirmed link; null → plain
     * text (it was never a citation). First occurrence only — the fingerprint identifies it.
     */
    private function applyChoice(string $content, array $anchor, ?string $chosen): string
    {
        $replacement = $chosen === null
            ? $anchor['year']
            : '<a class="in-text-citation" data-resolved="confirmed" href="#' . $chosen . '">'
              . $anchor['year'] . '</a>';

        $pos = strpos($content, $anchor['raw']);
        if ($pos === false) {
            return $content;
        }
        return substr_replace($content, $replacement, $pos, strlen($anchor['raw']));
    }
}

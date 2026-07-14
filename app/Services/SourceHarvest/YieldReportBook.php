<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Writes the "Source Yield Report" — a readable book, placed on the harvest
 * shelf, that lists in BibTeX (with links) every cited open-access work the
 * automatic harvester could NOT pull, above a secondary list of what it did.
 *
 * It exists as much for morale as information: a Cloudflare wall or an
 * unverifiable copy defeats the automation, but rarely a determined human —
 * a repository login, an institutional proxy, or a click by hand usually
 * still gets the text.
 *
 * One LIVING report per (creator, root book): re-running the harvest
 * regenerates the same book in place (found by a raw_json marker), so a work
 * that failed before and succeeds later just moves to the harvested list.
 *
 * All writes via pgsql_admin (queue-worker context). Nodes are inserted with
 * the raw builder (like ShelfController's LibraryCardGenerator output), which
 * bypasses the PgNode saving hook — so report text spawns no embedding jobs.
 */
class YieldReportBook
{
    /** Statuses that mean the work made it into the library. */
    private const SUCCESS = ['assigned', 'assigned_existing'];

    /**
     * Generate/refresh the yield report for a harvest root and return its book
     * id, or null when the root book has no named creator (no user page to
     * live on — same rule as the shelf).
     *
     * @param array<int, array<string, mixed>> $results per-work outcomes
     */
    public function generate(string $rootBook, string $rootTitle, array $results): ?string
    {
        $db = DB::connection('pgsql_admin');

        $creator = $db->table('library')->where('book', $rootBook)->value('creator');
        if (!$creator) {
            return null;
        }

        $bookId = 'source-yield-report-' . $rootBook;

        // CUMULATIVE union of per-work outcomes across ALL runs on this book,
        // keyed by canonical_source_id and stored on the report row's raw_json.
        // A later (possibly smaller/cheaper) run only ADDS or UPGRADES entries
        // and never clobbers an earlier, fuller report: a run's `results` only
        // contains works still eligible at run time (eligibility excludes
        // already-harvested canonicals), so merging with success>failure>skip
        // precedence moves a Failed→Harvested and leaves prior successes intact.
        // Runs are sequential (the controller 409s a concurrent harvest), so
        // there's no read-modify-write race here.
        $union = $this->mergeResults($this->readUnion($db, $bookId), $results);

        $successes = array_values(array_filter($union, fn ($r) => in_array($r['status'] ?? '', self::SUCCESS, true)));
        // Works never attempted because the spend cap was reached — their own
        // section (they aren't failures, just deferred for a top-up + rerun).
        $overBudget = array_values(array_filter($union, fn ($r) => ($r['status'] ?? '') === 'skipped_over_budget'));
        $failures = array_values(array_filter($union, fn ($r) =>
            !in_array($r['status'] ?? '', self::SUCCESS, true) && ($r['status'] ?? '') !== 'skipped_over_budget'));

        $bookId = $this->findOrMintReportRow($db, $creator, $rootBook, $rootTitle);

        // Purge any OTHER report for this root (an older random-UUID report
        // from before the deterministic-id convention, or any stray) so the
        // shelf self-heals to exactly one living report.
        $this->purgeStaleReports($db, $rootBook, $bookId);

        // Rebuild the nodes from the full union (not just this run).
        $db->table('nodes')->where('book', $bookId)->delete();
        $blocks = $this->buildBlocks($rootBook, $rootTitle, $failures, $successes, $overBudget, $union);
        $this->insertNodes($db, $bookId, $blocks);

        // Persist the union back onto the report row so the next run accumulates.
        $this->writeUnion($db, $bookId, $rootBook, $union);

        return $bookId;
    }

    /** The cumulative union of prior runs, read from the report row's raw_json. */
    private function readUnion($db, string $bookId): array
    {
        $raw = $db->table('library')->where('book', $bookId)->value('raw_json');
        if (!$raw) {
            return [];
        }
        $data = json_decode($raw, true);
        return is_array($data['cumulative_results'] ?? null) ? $data['cumulative_results'] : [];
    }

    /**
     * Merge a run's results into the running union, keyed by canonical_source_id.
     * A higher-rank status (success > failure > skipped_over_budget) is never
     * replaced by a lower one; on equal rank the fresher (new) entry wins.
     */
    private function mergeResults(array $existing, array $new): array
    {
        $rank = fn ($r) => in_array($r['status'] ?? '', self::SUCCESS, true) ? 3
            : (($r['status'] ?? '') === 'skipped_over_budget' ? 1 : 2);

        $byKey = [];
        foreach ([$existing, $new] as $i => $set) {
            foreach ($set as $r) {
                $k = $r['canonical_source_id'] ?? ($r['title'] ?? null);
                if ($k === null) {
                    $byKey[] = $r; // no stable key — keep as-is
                    continue;
                }
                if (!isset($byKey[$k]) || $rank($r) >= $rank($byKey[$k])) {
                    $byKey[$k] = $r;
                }
            }
        }
        return array_values($byKey);
    }

    /** Persist the union + flip has_nodes, preserving the row's other raw_json keys. */
    private function writeUnion($db, string $bookId, string $rootBook, array $union): void
    {
        $raw = $db->table('library')->where('book', $bookId)->value('raw_json');
        $data = is_array(json_decode($raw ?? '', true)) ? json_decode($raw, true) : [];
        $data['cumulative_results'] = array_values($union);
        $data['report_of'] = $rootBook;

        $db->table('library')->where('book', $bookId)->update([
            'has_nodes'  => true,
            'raw_json'   => json_encode($data),
            'timestamp'  => round(microtime(true) * 1000),
            'updated_at' => now(),
        ]);
    }

    /** Remove any report book for this root other than the canonical one (nodes + shelf items + row). */
    private function purgeStaleReports($db, string $rootBook, string $keepBookId): void
    {
        $stale = $db->table('library')
            ->whereRaw("raw_json->>'report_of' = ?", [$rootBook])
            ->where('book', '!=', $keepBookId)
            ->pluck('book');
        if ($stale->isEmpty()) {
            return;
        }
        $ids = $stale->all();
        $db->table('nodes')->whereIn('book', $ids)->delete();
        $db->table('shelf_items')->whereIn('book', $ids)->delete();
        $db->table('library')->whereIn('book', $ids)->delete();
    }

    private function findOrMintReportRow($db, string $creator, string $rootBook, string $rootTitle): string
    {
        // Deterministic, human-readable id tied to the book being harvested —
        // one living report per root, addressable at /source-yield-report-<root>.
        $bookId = 'source-yield-report-' . $rootBook;

        if ($db->table('library')->where('book', $bookId)->exists()) {
            return $bookId;
        }

        // A commons book's report is a shared public artifact (no user owner);
        // a normal user's report stays private to them.
        $isCommons = $creator === \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;

        $title = 'Source Yield Report — ' . Str::limit($rootTitle, 120, '…');
        $db->table('library')->insert([
            'book'          => $bookId,
            'title'         => $title,
            'author'        => 'Hyperlit',
            'creator'       => $creator,
            'creator_token' => null,
            'visibility'    => $isCommons ? 'public' : 'private',
            'listed'        => false,
            'has_nodes'     => false, // flipped true after nodes land
            'type'          => 'report',
            'timestamp'     => round(microtime(true) * 1000),
            'raw_json'      => json_encode([
                'book'         => $bookId,
                'type'         => 'report',
                'report_of'    => $rootBook,
                'title'        => $title,
                'generated_at' => now()->toIso8601String(),
            ]),
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        return $bookId;
    }

    /**
     * The report as an ordered list of [tag, innerHtml] blocks (one node each).
     *
     * @return array<int, array{0: string, 1: string}>
     */
    private function buildBlocks(string $rootBook, string $rootTitle, array $failures, array $successes, array $overBudget = [], array $union = []): array
    {
        $got = count($successes);
        $lost = count($failures);
        $deferred = count($overBudget);
        $tried = $got + $lost; // over-budget works were never attempted
        $blocks = [];

        $blocks[] = ['h1', 'Source Yield Report'];

        // The source book's title, with an arrow link back to the book the
        // harvest was launched from (opens where the report lives, in-app).
        $backLink = '<a href="/' . $this->e(rawurlencode($rootBook)) . '" title="Back to the book">→</a>';
        $intro = 'Harvesting the knowledge commons cited by <strong>' . $this->e($rootTitle) . '</strong> ' . $backLink . '. '
            . 'The harvester tried ' . $tried . ' open-access ' . $this->plural($tried, 'text')
            . ' — ' . $got . ' came home, ' . $lost . ' it could not pull.';
        if ($deferred > 0) {
            $intro .= ' A further ' . $deferred . ' ' . $this->plural($deferred, 'text')
                . ' went untried when the spending limit was reached.';
        }
        $blocks[] = ['p', $intro];

        // The knowledge network the harvest built, as a fork tree. Stored as a
        // plain data table (the sanitizer blocks <svg> in node content); the
        // client-side graph renderer (lazyLoader/graphRenderer.ts) finds the
        // data-chart marker and swaps the table for a rendered SVG — the same
        // pattern as the citation-review report's charts. If JS never runs,
        // the table itself is a legible fallback.
        if ($union !== []) {
            $blocks[] = ['h2', 'Knowledge Network'];
            $blocks[] = ['table', $this->networkTableInner($rootBook, $rootTitle, $union),
                'data-chart="harvest-network"', 'Harvest knowledge network'];
            // target="_blank": the 3D page is standalone (non-SPA) — a same-tab
            // click would be intercepted by LinkNavigationHandler and misread
            // as a book id (it also skips _blank links now, belt-and-braces).
            $blocks[] = ['p', '<a href="/harvest-network/' . $this->e(rawurlencode($rootBook)) . '"'
                . ' target="_blank" rel="noopener">Explore the knowledge network in 3D →</a>'];
        }

        if ($lost > 0) {
            $blocks[] = ['p',
                'The texts under <em>Failed to Harvest</em> defeated Hyperlit\'s automatic harvester — usually a '
                . 'publisher\'s Cloudflare wall or a copy we couldn\'t verify as the genuine article. That does '
                . '<strong>not</strong> mean they are beyond you: a repository login, an institutional proxy, or '
                . 'simply clicking through by hand will often get them. Have strength — a human is often needed, comrades!'
            ];

            $blocks[] = ['h2', 'Failed to Harvest'];
            foreach ($failures as $r) {
                // A formatted academic citation (title linked to the best
                // available source), then a muted line with the reason + any
                // other links to try. Mirrors the frontend's
                // formatMetadataToCitation (utilities/bibtexProcessor.ts).
                $blocks[] = ['p', $this->formatCitation($r, $this->bestLink($r))];
                $foot = $this->footLine($r);
                if ($foot !== '') {
                    $blocks[] = ['p', $foot];
                }
            }
        }

        if ($got > 0) {
            $blocks[] = ['h2', 'Harvested'];
            $blocks[] = ['p', 'Imported into the library as verified source texts — each opens where its citation points.'];
            foreach ($successes as $r) {
                $link = !empty($r['book']) ? '/' . rawurlencode($r['book']) : null;
                $blocks[] = ['p', $this->formatCitation($r, $link)];
            }
        }

        if ($deferred > 0) {
            $blocks[] = ['h2', 'Not yet harvested (spending limit reached)'];
            $blocks[] = ['p',
                'The harvest stopped at your spending limit before reaching these open-access works. Raise the '
                . 'limit (or top up credits) and run the harvest again to pull them — no work is repeated, so a '
                . 'rerun picks up exactly here.'
            ];
            foreach ($overBudget as $r) {
                $blocks[] = ['p', $this->formatCitation($r, $this->bestLink($r))];
            }
        }

        if ($tried === 0 && $deferred === 0) {
            $blocks[] = ['p', 'No open-access works were eligible to fetch from this book\'s citations.'];
        }

        return $blocks;
    }

    /**
     * Insert the blocks as node rows (raw, pgsql_admin — no embedding jobs).
     *
     * A block is [tag, innerHtml] with two optional extras:
     * [2] a pre-escaped attribute string baked into the opening tag (e.g. the
     *     data-chart marker the client-side graph renderer looks for), and
     * [3] a plainText override (the network table's plainText would otherwise
     *     be every cell id smashed together by strip_tags).
     */
    private function insertNodes($db, string $bookId, array $blocks): void
    {
        $now = now();
        $rows = [];
        foreach ($blocks as $i => $block) {
            [$tag, $inner] = $block;
            $attrs = isset($block[2]) ? ' ' . $block[2] : '';
            $line = $i + 1;
            $nodeId = $bookId . '_r' . $line;
            // Bake id="<startLine>" + data-node-id into the opening tag, the same
            // convention as converted books / LibraryCardGenerator. The TOC heading
            // scanner (tocContainer) and the /headings endpoint both require a
            // literal id="…" in the stored content to recognise a heading — without
            // it the report's <h2>s never reach the table of contents.
            $rows[] = [
                'book'       => $bookId,
                'startLine'  => $line,
                'chunk_id'   => floor($i / 100),
                'node_id'    => $nodeId,
                'content'    => "<{$tag} id=\"{$line}\" data-node-id=\"{$nodeId}\"{$attrs}>{$inner}</{$tag}>",
                'plainText'  => $block[3] ?? strip_tags($inner),
                'type'       => $tag,
                'footnotes'  => null,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        foreach (array_chunk($rows, 500) as $batch) {
            $db->table('nodes')->insert($batch);
        }
    }

    /**
     * A formatted academic citation — the PHP port of
     * formatMetadataToCitation (resources/js/utilities/bibtexProcessor.ts):
     * "Author, "Title" (linked), Journal (Year)." for articles, italic title
     * for books. $linkUrl wraps the title (the held version for a success, the
     * best external source for a failure); null leaves it unlinked.
     */
    private function formatCitation(array $r, ?string $linkUrl): string
    {
        $author = trim((string) ($r['author'] ?? '')) ?: 'Unknown Author';
        $title  = (string) ($r['title'] ?? '') ?: 'Untitled';
        $journal = $r['journal'] ?? null;
        $publisher = $r['publisher'] ?? null;
        $year = $r['year'] ?? null;
        $type = strtolower((string) ($r['type'] ?? 'misc'));

        $isArticle = in_array($type, ['article', 'journal-article', 'journal article', 'proceedings-article', 'conference-paper', 'paper'], true);
        $isChapter = in_array($type, ['incollection', 'book-chapter', 'chapter', 'book chapter'], true);

        // Quotes for articles/chapters, italics for books.
        $formattedTitle = ($isArticle || $isChapter) ? '"' . $this->e($title) . '"' : '<i>' . $this->e($title) . '</i>';
        if ($linkUrl) {
            $target = str_starts_with($linkUrl, '/') ? '' : ' target="_blank" rel="noopener"';
            $formattedTitle = '<a href="' . $this->e($linkUrl) . '"' . $target . '>' . $formattedTitle . '</a>';
        }

        $citation = $this->e($author) . ', ' . $formattedTitle;
        if ($isArticle) {
            if ($journal) $citation .= ', ' . $this->e($journal);
            if ($year) $citation .= ' (' . $this->e((string) $year) . ')';
        } else {
            if ($publisher) {
                $citation .= ' (' . $this->e($publisher);
                if ($year) $citation .= ', ' . $this->e((string) $year);
                $citation .= ')';
            } elseif ($year) {
                $citation .= ' (' . $this->e((string) $year) . ')';
            }
        }

        return $citation . '.';
    }

    /**
     * The harvest network encoded as sanitizer-safe table rows for the
     * client-side fork-tree renderer (lazyLoader/graphRenderer.ts).
     *
     * COLUMN ORDER IS THE RENDERER CONTRACT (keep in sync with graphRenderer):
     * id | parent | depth | status | title | year | book | cited_by | link |
     * author | journal | publisher | type | reason
     * (the last five feed the hover citation card; APPEND new columns only —
     * the renderer indexes by position and tolerates short legacy rows).
     *
     * First body row is the ROOT book (depth 0, status "root"); then one row
     * per union entry. Legacy entries (pre-lineage harvests) default to
     * depth 1 / parent = root — a correct 1-level fan.
     */
    private function networkTableInner(string $rootBook, string $rootTitle, array $union): string
    {
        $cells = fn (array $c) => '<tr>' . implode('', array_map(
            fn ($v) => '<td>' . $this->e((string) ($v ?? '')) . '</td>', $c)) . '</tr>';

        $head = '<thead><tr>'
            . implode('', array_map(fn ($h) => "<th>{$h}</th>",
                ['id', 'parent', 'depth', 'status', 'title', 'year', 'book', 'cited_by', 'link',
                 'author', 'journal', 'publisher', 'type', 'reason']))
            . '</tr></thead>';

        $rows = [$cells([$rootBook, '', 0, 'root', $rootTitle, '', $rootBook, '', '', '', '', '', '', ''])];
        foreach ($union as $r) {
            $id = $r['canonical_source_id'] ?? ($r['title'] ?? null);
            if ($id === null) {
                continue; // no stable identity — can't be a graph node
            }
            $rows[] = $cells([
                $id,
                $r['parent_book'] ?? $rootBook,
                $r['depth'] ?? 1,
                $r['status'] ?? 'error',
                $r['title'] ?? 'Untitled',
                $r['year'] ?? '',
                $r['book'] ?? '',
                $r['cited_by_count'] ?? '',
                $this->bestLink($r) ?? '',
                $r['author'] ?? '',
                $r['journal'] ?? '',
                $r['publisher'] ?? '',
                $r['type'] ?? '',
                $r['reason'] ?? '',
            ]);
        }

        return $head . '<tbody>' . implode('', $rows) . '</tbody>';
    }

    /** The best single source URL for a work (used as the title link). */
    private function bestLink(array $r): ?string
    {
        if (!empty($r['doi']))     return 'https://doi.org/' . $r['doi'];
        if (!empty($r['oa_url']))  return $r['oa_url'];
        if (!empty($r['pdf_url'])) return $r['pdf_url'];
        return null;
    }

    /** Muted line under a failed citation: the reason + any OTHER links to try. */
    private function footLine(array $r): string
    {
        $primary = $this->bestLink($r);
        $extras = [];
        foreach ([
            [!empty($r['doi']) ? 'https://doi.org/' . $r['doi'] : null, 'doi.org'],
            [$r['oa_url'] ?? null, 'open-access page'],
            [$r['pdf_url'] ?? null, 'PDF'],
        ] as [$url, $label]) {
            if ($url && $url !== $primary) {
                $extras[] = $this->anchor($url, $label);
            }
        }

        $bits = [];
        $reason = $this->humanReason($r);
        if ($reason) $bits[] = $this->e($reason);
        if ($extras) $bits[] = 'also try: ' . implode(' · ', $extras);

        return $bits ? '<span style="color:var(--color-text-faint);">' . implode(' — ', $bits) . '</span>' : '';
    }

    private function humanReason(array $r): string
    {
        $status = $r['status'] ?? '';
        $reason = (string) ($r['reason'] ?? '');
        if ($status === 'deferred') {
            return 'found a copy but couldn\'t verify it\'s the genuine text';
        }
        if (preg_match('/cloudflare|just a moment|\b40[13]\b/i', $reason)) {
            return 'blocked by the publisher (Cloudflare)';
        }
        return $reason !== '' ? $reason : 'could not be fetched';
    }

    private function anchor(string $url, string $label): string
    {
        return '<a href="' . $this->e($url) . '" target="_blank" rel="noopener">' . $this->e($label) . '</a>';
    }

    private function plural(int $n, string $word): string
    {
        return $n === 1 ? $word : $word . 's';
    }

    private function e(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    }
}

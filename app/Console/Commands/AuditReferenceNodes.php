<?php

namespace App\Console\Commands;

use App\Services\EmbeddingEligibility;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Read-only audit of EmbeddingEligibility::referenceSql against the real
 * corpus: does the predicate still describe how this codebase creates
 * bibliography and footnote content?
 *
 * This exists because the predicate cannot be derived from the code alone.
 * Grepping the writers finds the markers, but it does not tell you which
 * shapes actually reach the `nodes` table or in what volume — the 2026-09
 * pass found 26k raw markdown footnote definitions (`<p>[^38]: …</p>`) that
 * the code reading had filed as a negligible edge case, and it found that a
 * `class="[^"]*footnote"` pattern would have swallowed 125k inline prose
 * markers. Both were data findings, not code findings.
 *
 * Run it after adding an import path, or whenever semantic search starts
 * returning reference matter again. A new lane that emits an unrecognised
 * shape shows up here as an unknown class name or a growing unmarked sample.
 */
class AuditReferenceNodes extends Command
{
    protected $signature = 'embeddings:audit-references {--samples=8 : unmarked citation-shaped nodes to sample}';

    protected $description = 'Audit which nodes the embedding reference-matter predicate catches (read-only)';

    /**
     * Citation-SHAPED text, detected independently of any marker — the control
     * group. Nodes matching this but NOT the predicate are either genuine
     * misses or acceptable ambiguity; the sample is there to be eyeballed.
     */
    private const CITATION_SHAPE = <<<'SQL'
    ("plainText" ~ '^[0-9]{1,3}\.\s+[A-Z]'
     OR "plainText" ~ '^[A-Z][A-Za-z''-]+,?\s+[A-Z]\.?[A-Za-z.]*\s*\(?[12][0-9]{3}\)?'
     OR "plainText" ~ '\spp?\.\s*[0-9]+')
    SQL;

    public function handle(): int
    {
        $db = DB::connection('pgsql_admin');
        $ref = EmbeddingEligibility::referenceSql('nodes');

        $totals = $db->selectOne("
            SELECT count(*) AS nodes,
                   count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
                   count(*) FILTER (WHERE embedding IS NOT NULL AND {$ref}) AS ref_embedded,
                   count(DISTINCT book) FILTER (WHERE embedding IS NOT NULL AND {$ref}) AS ref_books
            FROM nodes");

        $this->info('Corpus');
        $this->line(sprintf('  nodes %s, embedded %s', number_format($totals->nodes), number_format($totals->embedded)));
        $this->line(sprintf(
            '  caught by referenceSql: %s embedded (%.2f%%) across %s books',
            number_format($totals->ref_embedded),
            $totals->embedded > 0 ? 100 * $totals->ref_embedded / $totals->embedded : 0,
            number_format($totals->ref_books),
        ));

        // Every data-static-content value present. The paste engine emits
        // exactly two; a third would mean a new lane nobody told us about.
        $this->newLine();
        $this->info('data-static-content values in stored content');
        foreach ($db->select(<<<'SQL'
            SELECT (regexp_match(content, 'data-static-content="([^"]*)"'))[1] AS val, count(*) AS n
            FROM nodes WHERE content LIKE '%data-static-content=%' GROUP BY 1 ORDER BY n DESC
        SQL) as $row) {
            $this->line(sprintf('  %-22s %s', $row->val, number_format($row->n)));
        }

        // Reference-ish class names. `bib-entry` is the only one that means
        // "this node IS a reference"; footnote-ref / in-text-citation are
        // INLINE markers inside prose and must stay embedded.
        $this->newLine();
        $this->info('reference-ish class names (bib-entry excludes; the rest are inline and must NOT)');
        foreach ($db->select(<<<'SQL'
            SELECT cls, count(*) AS n FROM (
              SELECT unnest(regexp_matches(content, 'class="([^"]*)"', 'g')) AS cls
              FROM nodes WHERE content ~* 'class="[^"]*(bib|ref|foot|note|cit|endnote)'
            ) t
            WHERE cls ~* '(bib|ref|foot|note|cit|endnote)'
            GROUP BY 1 ORDER BY n DESC LIMIT 15
        SQL) as $row) {
            $this->line(sprintf('  %-34s %s', $row->cls, number_format($row->n)));
        }

        // The control group: citation-shaped text the predicate does not catch.
        $shape = self::CITATION_SHAPE;
        $gap = $db->selectOne("
            SELECT count(*) FILTER (WHERE embedding IS NOT NULL AND {$shape}) AS shaped,
                   count(*) FILTER (WHERE embedding IS NOT NULL AND {$shape} AND NOT {$ref}) AS unmarked
            FROM nodes");

        $this->newLine();
        $this->info('Control group: citation-SHAPED text, detected without markers');
        $this->line(sprintf(
            '  %s embedded, of which %s (%.1f%%) are NOT caught',
            number_format($gap->shaped),
            number_format($gap->unmarked),
            $gap->shaped > 0 ? 100 * $gap->unmarked / $gap->shaped : 0,
        ));
        $this->line('  Expect a nonzero remainder: the shape also matches ordinary numbered');
        $this->line('  lists and prose citing a year, which must stay embedded. Read the');
        $this->line('  sample — a run of real reference entries means a lane needs a marker.');

        $samples = max(0, (int) $this->option('samples'));
        if ($samples > 0) {
            $this->newLine();
            foreach ($db->select("
                SELECT LEFT(\"plainText\", 110) AS ex FROM nodes
                WHERE embedding IS NOT NULL AND {$shape} AND NOT {$ref}
                ORDER BY random() LIMIT {$samples}") as $row) {
                $this->line('  * ' . preg_replace('/\s+/', ' ', $row->ex));
            }
        }

        return Command::SUCCESS;
    }
}

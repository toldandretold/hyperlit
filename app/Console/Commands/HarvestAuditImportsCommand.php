<?php

namespace App\Console\Commands;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Re-check ALREADY-IMPORTED harvested sources for a missing article body — the
 * backfill half of the acquisition-gate fix (see ContentFetchService's gates).
 *
 * The live gate only protects fetches from now on. Everything the harvester
 * imported BEFORE it is still in the library, public and cited: a paywalled
 * Springer landing page published under the real work's title, a JSTOR
 * PerimeterX interstitial published as "Copyright and a Democratic Civil
 * Society". This asks the body question for all of them at once, measuring
 * from the STORED NODES — free, offline, no re-fetch, no OCR.
 *
 * SCOPE IS DELIBERATELY NARROW, and the first version got this badly wrong: it
 * matched on `creator = canonicalizer_v1`, which SUB-BOOKS INHERIT, so every
 * annotation and footnote sub-book ("Annotation: seq1_Fn…") was audited as if
 * it were a work. A footnote is one paragraph; of course it scored zero prose
 * blocks. Result: 3,851 of 4,015 "suspects" and a flooded triage queue. Two
 * rules follow from that:
 *
 *   1. Sub-books are NEVER audited (`book LIKE '%/%'` — see SubBookIdHelper:
 *      every sub-book id contains a slash). They are parts of a work, not works.
 *   2. Scope is the harvester's OWN output — rows minted by SystemVersionMinter
 *      (`foundation_source = canonical_pdf_vacuum`) or carrying an acquisition
 *      conversion_method. Not "anything the canonicalizer touched".
 *
 * And a standing guard: if more than SANE_SUSPECT_RATE of the audited set looks
 * absent, the audit is measuring the wrong thing, not discovering a catastrophe
 * — it refuses to write flags without --force.
 */
class HarvestAuditImportsCommand extends Command
{
    protected $signature = 'harvest:audit-imports
        {--flag : Raise an auto_sweep conversion_flag for each suspect (shows up in /maintainer/conversion)}
        {--unflag : UNDO — delete every flag a previous --flag run raised, and stop}
        {--stats : Print the prose distribution over the audited set instead of flagging (use this to calibrate)}
        {--method= : Only audit this conversion_method}
        {--book= : Only audit this book}
        {--limit=0 : Stop after N books (0 = all)}
        {--force : Flag even when the suspect rate looks implausible}
        {--all : List every audited book, not just the suspects}';

    protected $description = 'Find already-imported harvested sources whose article body is missing (paywalled landing page / captcha)';

    /**
     * conversion_methods produced by the acquisition ladder. A user's own upload
     * is out of scope — this audits what the SYSTEM fetched on their behalf.
     * Single source: HarvestRetraction (retraction scopes by the same list).
     */
    private const ACQUIRED_METHODS = \App\Services\Conversion\HarvestRetraction::ACQUIRED_METHODS;

    /** Above this share of the audited set, refuse to flag: the measure is wrong, not the corpus. */
    private const SANE_SUSPECT_RATE = 0.25;

    /** Marks the flags this command raises, so --unflag can remove exactly those. */
    private const ISSUE_TYPE = 'body_absent';

    public function handle(BodyPresenceAssessor $assessor): int
    {
        if ($this->option('unflag')) {
            return $this->unflag();
        }

        $db = DB::connection('pgsql_admin');

        $query = $db->table('library')
            ->where('has_nodes', true)
            // Sub-books (annotations / footnotes) are parts of a work, never works.
            ->where('book', 'not like', '%/%')
            ->where(function ($q) {
                $q->where('foundation_source', AutoVersionResolver::FOUNDATION_SOURCE)
                    ->orWhere('foundation_source', AutoVersionResolver::AR5IV_FOUNDATION_SOURCE)
                    ->orWhereIn('conversion_method', self::ACQUIRED_METHODS);
            });

        if ($method = $this->option('method')) {
            $query->where('conversion_method', $method);
        }
        if ($book = $this->option('book')) {
            $query->where('book', $book);
        }
        if (($limit = (int) $this->option('limit')) > 0) {
            $query->limit($limit);
        }

        $books = $query->orderBy('book')->get(['book', 'title', 'conversion_method', 'visibility']);
        if ($books->isEmpty()) {
            $this->info('No harvested books to audit.');
            return self::SUCCESS;
        }

        $this->line("Auditing {$books->count()} harvested book(s)…");
        $this->newLine();

        $suspects = [];
        $distribution = [];
        foreach ($books as $row) {
            $result = $assessor->assessBlocks($this->nodeTexts($db, $row->book), $this->profileFor($row));
            $distribution[] = $result['prose_blocks'];

            if ($result['verdict'] === BodyPresenceAssessor::ABSENT) {
                $suspects[] = [$row, $result];
                if (!$this->option('stats')) {
                    $this->warn(sprintf(
                        '  SUSPECT  %s  [%s]  %d prose block(s) / %d chars',
                        $row->book, $row->conversion_method ?: '—', $result['prose_blocks'], $result['prose_chars'],
                    ));
                    $this->line('           ' . mb_strimwidth((string) $row->title, 0, 90, '…'));
                }
            } elseif ($this->option('all') && !$this->option('stats')) {
                $this->line(sprintf(
                    '  ok       %s  [%s]  %d prose block(s) / %d chars',
                    $row->book, $row->conversion_method ?: '—', $result['prose_blocks'], $result['prose_chars'],
                ));
            }
        }

        if ($this->option('stats')) {
            return $this->printStats($distribution, count($suspects), $books->count());
        }

        $rate = count($suspects) / max(1, $books->count());
        $this->newLine();
        $this->info(sprintf('%d suspect(s) of %d audited (%.1f%%).', count($suspects), $books->count(), $rate * 100));

        if (!$this->option('flag')) {
            $this->line('Re-run with --flag to queue these for triage, or --stats to see the distribution first.');
            return self::SUCCESS;
        }

        if ($rate > self::SANE_SUSPECT_RATE && !$this->option('force')) {
            $this->newLine();
            $this->error(sprintf(
                'REFUSING to flag: %.1f%% of the audited set looks body-absent (sane ceiling %.0f%%).',
                $rate * 100, self::SANE_SUSPECT_RATE * 100,
            ));
            $this->line('A rate that high means the MEASURE is wrong, not that the corpus is. Run --stats');
            $this->line('to see the distribution and re-calibrate before writing thousands of flags.');
            $this->line('If you really do mean it, add --force.');
            return self::FAILURE;
        }

        $flagged = 0;
        foreach ($suspects as [$row, $result]) {
            \App\Models\ConversionFlag::raise(
                $row->book,
                \App\Models\ConversionFlag::SOURCE_AUTO_SWEEP,
                'no article body — likely a paywalled landing page or a bot-wall interstitial',
                [
                    'issueTypes'   => [self::ISSUE_TYPE],
                    'prose_blocks' => $result['prose_blocks'],
                    'prose_chars'  => $result['prose_chars'],
                    'case_kind'    => BookExport::KIND_HARVEST,
                    'audited_at'   => now()->toIso8601String(),
                ],
            );
            $flagged++;
        }

        $this->line("{$flagged} flagged → triage at /maintainer/conversion");
        $this->line('Undo with: php artisan harvest:audit-imports --unflag');

        return self::SUCCESS;
    }

    /**
     * Delete every flag raised by a --flag run. Targets ONLY this command's
     * flags (auto_sweep + our issueType), so `library:flag-sweep`'s own
     * auto_sweep flags and every user report survive untouched.
     */
    private function unflag(): int
    {
        // jsonb_exists(), NOT the `?` containment operator: PDO reads a literal
        // `?` in the SQL as a bind placeholder and the statement blows up.
        $deleted = DB::table('conversion_flags')
            ->where('source', \App\Models\ConversionFlag::SOURCE_AUTO_SWEEP)
            ->whereRaw("jsonb_exists(details->'issueTypes', ?)", [self::ISSUE_TYPE])
            ->delete();

        $this->info("Deleted {$deleted} body-absent audit flag(s).");
        $this->line('User reports and library:flag-sweep flags were not touched.');

        return self::SUCCESS;
    }

    /**
     * Print the prose-block distribution so the threshold can be set from the
     * REAL corpus rather than from a handful of fixtures.
     */
    private function printStats(array $blocks, int $suspects, int $total): int
    {
        sort($blocks);
        $at = fn (float $p) => $blocks[(int) floor($p * (count($blocks) - 1))] ?? 0;

        $buckets = [];
        foreach ($blocks as $b) {
            $key = $b === 0 ? '0' : ($b < 5 ? '1-4' : ($b < 10 ? '5-9' : ($b < 26 ? '10-25' : '26+')));
            $buckets[$key] = ($buckets[$key] ?? 0) + 1;
        }

        $this->newLine();
        $this->info("Prose-block distribution over {$total} harvested book(s):");
        foreach (['0', '1-4', '5-9', '10-25', '26+'] as $key) {
            $n = $buckets[$key] ?? 0;
            $this->line(sprintf('  %-6s %6d  (%.1f%%)  %s', $key, $n, $n / max(1, $total) * 100, str_repeat('█', (int) round($n / max(1, $total) * 40))));
        }
        $this->newLine();
        $this->line(sprintf('  p10=%d  p25=%d  median=%d  p75=%d  p90=%d', $at(0.10), $at(0.25), $at(0.50), $at(0.75), $at(0.90)));
        $this->line(sprintf('  current threshold would flag %d (%.1f%%)', $suspects, $suspects / max(1, $total) * 100));

        return self::SUCCESS;
    }

    /**
     * Same profile split the live gate uses: a web source is a fraction the
     * length of a journal article, so judging it by the scholarly bar would
     * report every legitimate short news piece as a suspect.
     */
    private function profileFor(object $row): string
    {
        return str_starts_with((string) $row->conversion_method, 'web_article')
            ? BodyPresenceAssessor::PROFILE_WEB
            : BodyPresenceAssessor::PROFILE_SCHOLARLY;
    }

    /**
     * The book's node text in reading order. plainText is the block text the
     * assessor wants; streamed so a huge book doesn't materialise in memory.
     *
     * @return list<string>
     */
    private function nodeTexts($db, string $book): array
    {
        $texts = [];
        $db->table('nodes')->where('book', $book)
            ->orderBy('startLine')
            ->select('plainText', 'content')
            ->chunk(1000, function ($nodes) use (&$texts) {
                foreach ($nodes as $n) {
                    $texts[] = $n->plainText !== null && $n->plainText !== ''
                        ? $n->plainText
                        : strip_tags((string) $n->content);
                }
            });

        return $texts;
    }
}

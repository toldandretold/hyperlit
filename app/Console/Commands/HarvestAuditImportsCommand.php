<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Re-check every ALREADY-IMPORTED system-acquired source for a missing article
 * body — the backfill half of the acquisition-gate fix.
 *
 * The gate in ContentFetchService only protects fetches from now on. Everything
 * the harvester imported BEFORE it is still sitting in the library, public and
 * cited: a paywalled Springer landing page published as "Availability of
 * digital object identifiers in publications archived by PubMed", a JSTOR
 * PerimeterX interstitial published as "Copyright and a Democratic Civil
 * Society". Both surfaced only because a reader happened to open one and
 * report it. This command asks the question for every one of them at once.
 *
 * It re-measures from the STORED NODES, not by re-fetching: BodyPresenceAssessor
 * works on block text, and the nodes are the block text. So the whole audit is
 * free, offline, and costs no OCR, no proxy traffic, and no publisher goodwill.
 */
class HarvestAuditImportsCommand extends Command
{
    protected $signature = 'harvest:audit-imports
        {--flag : Raise an auto_sweep conversion_flag for each suspect (shows up in /maintainer/conversion)}
        {--method= : Only audit this conversion_method}
        {--book= : Only audit this book}
        {--limit=0 : Stop after N books (0 = all)}
        {--all : List every audited book, not just the suspects}';

    protected $description = 'Find already-imported sources whose article body is missing (paywalled landing page / captcha)';

    /**
     * conversion_methods produced by the acquisition ladder. A user's own upload
     * is out of scope — this audits what the SYSTEM fetched on their behalf.
     */
    private const ACQUIRED_METHODS = [
        'pdf_ocr_auto_raw', 'jats_fulltext', 'paste_engine_html', 'ar5iv_html',
        'html_scrape_unverified', 'web_article_verified', 'web_article_unverified',
    ];

    public function handle(BodyPresenceAssessor $assessor): int
    {
        $db = DB::connection('pgsql_admin');

        $query = $db->table('library')
            ->where('has_nodes', true)
            ->where(function ($q) {
                $q->where('creator', AutoVersionResolver::CREATOR)
                    ->orWhere('foundation_source', AutoVersionResolver::FOUNDATION_SOURCE)
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

        $books = $query->orderBy('book')->get(['book', 'title', 'conversion_method', 'visibility', 'canonical_source_id']);
        if ($books->isEmpty()) {
            $this->info('No system-acquired books to audit.');
            return self::SUCCESS;
        }

        $this->line("Auditing {$books->count()} system-acquired book(s)…");
        $this->newLine();

        $suspects = 0;
        $flagged = 0;
        foreach ($books as $row) {
            // plainText is the node's text without markup — exactly the block
            // text the assessor expects. Streamed so a 5,000-node book doesn't
            // materialise in memory.
            $texts = [];
            $db->table('nodes')->where('book', $row->book)
                ->orderBy('startLine')
                ->select('plainText', 'content')
                ->chunk(1000, function ($nodes) use (&$texts) {
                    foreach ($nodes as $n) {
                        $texts[] = $n->plainText !== null && $n->plainText !== ''
                            ? $n->plainText
                            : strip_tags((string) $n->content);
                    }
                });

            // Same profile split the live gate uses: a web source is a fraction
            // the length of a journal article, so judging it by the scholarly
            // bar would report every legitimate short news piece as a suspect.
            $profile = str_starts_with((string) $row->conversion_method, 'web_article')
                ? BodyPresenceAssessor::PROFILE_WEB
                : BodyPresenceAssessor::PROFILE_SCHOLARLY;

            $result = $assessor->assessBlocks($texts, $profile);
            $isSuspect = $result['verdict'] === BodyPresenceAssessor::ABSENT;

            if ($isSuspect) {
                $suspects++;
                $this->warn(sprintf(
                    '  SUSPECT  %s  [%s]  %d prose block(s) / %d chars',
                    $row->book, $row->conversion_method ?: '—', $result['prose_blocks'], $result['prose_chars'],
                ));
                $this->line('           ' . mb_strimwidth((string) $row->title, 0, 90, '…'));

                if ($this->option('flag')) {
                    ConversionFlag::raise(
                        $row->book,
                        ConversionFlag::SOURCE_AUTO_SWEEP,
                        'no article body — likely a paywalled landing page or a bot-wall interstitial',
                        [
                            'issueTypes'   => ['body_absent'],
                            'prose_blocks' => $result['prose_blocks'],
                            'prose_chars'  => $result['prose_chars'],
                            'profile'      => $profile,
                            'case_kind'    => BookExport::KIND_HARVEST,
                            'audited_at'   => now()->toIso8601String(),
                        ],
                    );
                    $flagged++;
                }
            } elseif ($this->option('all')) {
                $this->line(sprintf(
                    '  ok       %s  [%s]  %d prose block(s) / %d chars',
                    $row->book, $row->conversion_method ?: '—', $result['prose_blocks'], $result['prose_chars'],
                ));
            }
        }

        $this->newLine();
        $this->info("{$suspects} suspect(s) of {$books->count()} audited.");
        if ($flagged > 0) {
            $this->line("{$flagged} flagged → triage at /maintainer/conversion");
        } elseif ($suspects > 0) {
            $this->line('Re-run with --flag to queue these for triage at /maintainer/conversion.');
        }

        // Suspects are a finding, not a command failure — never fail the exit
        // code, or a scheduled run would page someone every night.
        return self::SUCCESS;
    }
}

<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use App\Services\Metadata\JournalYearFloor;
use App\Services\Metadata\MetadataDriftDetector;
use App\Services\Metadata\PublisherPageMetadata;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Correct citation metadata from the publisher's own article page, and flag what it cannot settle.
 *
 * OpenAlex is wrong about some works, and asking the DOI registry does not help because the error
 * starts before OpenAlex: tripleC's `10.31269/triplec.v1i1.2` is deposited at CROSSREF as
 * `issued: 1970-01-01`. That is the Unix epoch — a null date serialised as a real one somewhere in
 * the publisher's deposit pipeline — and it comes back on every re-sync. The article's own OJS page
 * says `citation_date: 2003`, correctly.
 *
 * So this compares what we stored against what the publisher's page says. It reads pages we ALREADY
 * have on disk, which makes the default run free, offline and safely repeatable; `--fetch` is
 * opt-in for works whose page we never kept.
 *
 * What it does with a disagreement is the part worth knowing. It corrects only where the stored
 * value is PROVABLY broken — an epoch sentinel, a year before the journal existed, or an empty
 * column. Where both years are plausible and merely differ, it raises a `metadata_drift` flag for
 * a maintainer and writes nothing, because silently preferring the page would trade a known bug
 * for an unknown one. `MetadataDriftDetector` owns that split.
 */
class RepairPublicationYearsCommand extends Command
{
    protected $signature = 'library:repair-metadata
                            {--journal= : Registry slug to scope to (default: every journal-harvested work)}
                            {--suspect-only : Only works whose year already looks wrong (empty, a sentinel, or impossible for the journal)}
                            {--fetch : Also fetch the publisher page for works with no stored page (network, slow)}
                            {--limit=0 : Stop after N works (0 = no cap)}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = "Correct citation metadata from the publisher's article page and flag what it can't settle (OpenAlex/Crossref carry epoch-null dates for some works).";

    /**
     * `library:repair-years` was this command's name while it only ever touched the year. Kept as
     * an alias so the runbook in docs/journal-harvest.md and any prod shell history keep working.
     */
    protected $aliases = ['library:repair-years'];

    public function handle(
        MetadataDriftDetector $detector,
        PublisherPageMetadata $page,
        JournalYearFloor $floor,
        ContentFetchService $fetcher,
    ): int {
        $dry = (bool) $this->option('dry-run');
        $limit = (int) $this->option('limit');

        $query = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->whereNotNull('cs.journal_source_id')
            ->select('cs.id', 'cs.title', 'cs.year', 'cs.doi', 'cs.auto_version_book', 'cs.journal_source_id');

        if ($slug = trim((string) $this->option('journal'))) {
            $journalId = DB::connection('pgsql_admin')->table('journal_sources')->where('slug', $slug)->value('id');
            if (! $journalId) {
                $this->error("No registry journal with slug \"{$slug}\".");

                return 1;
            }
            $query->where('cs.journal_source_id', $journalId);
        }

        if ($this->option('suspect-only')) {
            // The cheap pass: works whose stored year already carries evidence of breakage —
            // empty, a deposit sentinel, in the future, or BEFORE THE JOURNAL EXISTED. That last
            // arm is why `journal_sources.first_year` was added: it catches a wrong year that is
            // not a recognisable sentinel, which no amount of pattern-matching on the value
            // alone could. A year that is merely EARLY but still after the journal started
            // remains invisible here — only the publisher page can settle that, which is why
            // this is an option and not the default.
            $query->leftJoin('journal_sources as js', 'js.id', '=', 'cs.journal_source_id')
                ->where(function ($q) {
                    $q->whereNull('cs.year')
                      ->orWhereIn('cs.year', JournalYearFloor::SENTINEL_YEARS)
                      ->orWhere('cs.year', '>', (int) date('Y') + 1)
                      ->orWhereRaw('js.first_year IS NOT NULL AND cs.year < js.first_year');
                });
        }

        $works = $query->orderBy('cs.id')->get();
        $this->info("Checking {$works->count()} work(s)…");
        $this->reportFloors($works, $floor);

        $changed = $flagged = $noPage = $noDate = $agreed = 0;

        foreach ($works as $work) {
            if ($limit > 0 && $changed >= $limit) {
                $this->warn("Stopped at --limit={$limit}.");
                break;
            }

            $html = $this->pageFor($work, $page, $fetcher);
            if ($html === null) {
                $noPage++;
                continue;
            }

            $result = $detector->inspect($work->id, $html, $dry);

            match ($result['status']) {
                'no_page', 'no_date' => $noDate++,
                'agreed'             => $agreed++,
                default              => null,
            };

            if ($result['status'] === 'corrected' || $result['status'] === 'flagged') {
                $this->renderVerdict($work, $result, $dry);
                $result['applied'] !== [] ? $changed++ : $agreed++;
                if ($result['status'] === 'flagged') {
                    $flagged++;
                }
            }
        }

        $this->newLine();
        $this->info(($dry ? 'Would fix ' : 'Fixed ') . "{$changed}; {$flagged} flagged for review; {$agreed} already correct; "
            . "{$noPage} with no stored page" . ($this->option('fetch') ? ' (fetch failed)' : ' (use --fetch)')
            . "; {$noDate} whose page carries no date.");

        if ($flagged > 0) {
            $this->newLine();
            $this->warn('Flagged works disagree in ways only a human can settle — review them in the import console:');
            $this->line('  /maintainer/journal-import/<slug>   (or /maintainer/shelf-import/<id>)');
        }

        if ($changed > 0 && ! $dry) {
            $this->newLine();
            $this->warn('Rendered feeds cache per shelf — drop the journal shelf renders so the new years show:');
            $this->line('  php artisan journal:harvest <slug> --max-works=0   # re-runs the shelf reconcile');
        }

        return 0;
    }

    /**
     * One line per field that moved or is disputed.
     *
     * @param array{status: string, fields: array, applied: array, rows: int} $result
     */
    private function renderVerdict(object $work, array $result, bool $dry): void
    {
        $title = mb_substr($work->title ?? '(untitled)', 0, 62);

        foreach ($result['fields'] as $field => $d) {
            [$label, $colour] = match ($d['action']) {
                'correct', 'fill' => [$dry ? 'would fix ' : 'fixed    ', 'green'],
                'dispute'         => ['DISPUTED ', 'yellow'],
                'reject_page'     => ['kept ours', 'gray'],
                default           => ['         ', 'gray'],
            };

            $this->line(sprintf(
                '  %s  %s  <fg=red>%s</> → <fg=%s>%s</>  %s  <fg=gray>(%s)</>',
                $label,
                $field,
                $this->show($d['stored']),
                $colour,
                $this->show($d['page']),
                $title,
                $d['rule'] ?? '—',
            ));
        }

        if ($result['rows'] > 0) {
            $this->line("             {$result['rows']} library row(s) updated");
        }
    }

    /** Show which plausibility floor each journal in this run is being judged against. */
    private function reportFloors(iterable $works, JournalYearFloor $floor): void
    {
        $ids = [];
        foreach ($works as $w) {
            if ($w->journal_source_id) {
                $ids[$w->journal_source_id] = true;
            }
        }
        if ($ids === []) {
            return;
        }

        foreach (DB::connection('pgsql_admin')->table('journal_sources')
            ->whereIn('id', array_keys($ids))
            ->get(['slug', 'first_year', 'first_year_source']) as $j) {
            $this->line($j->first_year
                ? "  floor: {$j->slug} — nothing before {$j->first_year} ({$j->first_year_source})"
                : "  floor: {$j->slug} — <fg=yellow>unknown</> (run journal:sync-registry to establish it)");
        }
        $this->newLine();
    }

    /** The publisher page for a work: the one we stored, or a fresh fetch when asked for. */
    private function pageFor(object $work, PublisherPageMetadata $page, ContentFetchService $fetcher): ?string
    {
        // Any lane's stored page will do — they are pages of the same article, and the citation
        // meta is the publisher's, not the lane's.
        $books = DB::connection('pgsql_admin')->table('library')
            ->where('canonical_source_id', $work->id)
            ->where('visibility', '!=', 'deleted')
            ->pluck('book');

        foreach ($books as $book) {
            if (($html = $page->storedPageFor($book)) !== null) {
                return $html;
            }
        }

        if (! $this->option('fetch') || ! $work->doi) {
            return null;
        }

        // Deliberately the PLAIN rung, not the whole acquisition ladder: we want a few meta tags,
        // not an import, and a metadata repair must never spend OCR money or run a browser.
        return $fetcher->fetchPageForMetadata('https://doi.org/' . $work->doi);
    }

    private function show(mixed $v): string
    {
        return ($v === null || $v === '') ? '(empty)' : (string) $v;
    }
}

<?php

namespace App\Console\Commands;

use App\Services\CanonicalVersions\PublisherYearRepair;
use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Correct publication years from the publisher's own article page.
 *
 * OpenAlex is wrong about some works, and asking the DOI registry does not help because the error
 * starts before OpenAlex: tripleC's `10.31269/triplec.v1i1.2` is deposited at CROSSREF as
 * `issued: 1970-01-01`. That is the Unix epoch — a null date serialised as a real one somewhere in
 * the publisher's deposit pipeline — and it comes back on every re-sync. The article's own OJS page
 * says `citation_date: 2003`, correctly.
 *
 * So this compares what we stored against what the publisher's page says, and takes the publisher's
 * answer. It reads pages we ALREADY have on disk, which makes the default run free, offline and
 * safely repeatable; `--fetch` is opt-in for works whose page we never kept.
 *
 * Deliberately evidence-driven rather than heuristic. "Anything before the journal started is
 * wrong" needs a start year we do not record, and even then only detects the error — it cannot say
 * what the year should be. `--suspect-only` exists for when you want the cheap pass anyway.
 */
class RepairPublicationYearsCommand extends Command
{
    protected $signature = 'library:repair-years
                            {--journal= : Registry slug to scope to (default: every journal-harvested work)}
                            {--suspect-only : Only works whose year already looks wrong (null, <=1970, or in the future)}
                            {--fetch : Also fetch the publisher page for works with no stored page (network, slow)}
                            {--limit=0 : Stop after N works (0 = no cap)}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = "Correct publication years from the publisher's article page (OpenAlex/Crossref carry epoch-null dates for some works).";

    public function handle(PublisherYearRepair $repair, ContentFetchService $fetcher): int
    {
        $dry = (bool) $this->option('dry-run');
        $limit = (int) $this->option('limit');

        $query = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->whereNotNull('cs.journal_source_id')
            ->select('cs.id', 'cs.title', 'cs.year', 'cs.doi', 'cs.auto_version_book');

        if ($slug = trim((string) $this->option('journal'))) {
            $journalId = DB::connection('pgsql_admin')->table('journal_sources')->where('slug', $slug)->value('id');
            if (! $journalId) {
                $this->error("No registry journal with slug \"{$slug}\".");

                return 1;
            }
            $query->where('cs.journal_source_id', $journalId);
        }

        if ($this->option('suspect-only')) {
            // 1970 is the epoch sentinel this exists for; the other two catch a null or a date
            // that has not happened yet. A year that is merely EARLY is not caught here — that is
            // the case only the publisher page can settle, which is why this is not the default.
            $query->where(function ($q) {
                $q->whereNull('cs.year')
                  ->orWhere('cs.year', '<=', 1970)
                  ->orWhere('cs.year', '>', (int) date('Y') + 1);
            });
        }

        $works = $query->orderBy('cs.id')->get();
        $this->info("Checking {$works->count()} work(s)…");

        $changed = $noPage = $noDate = $agreed = 0;

        foreach ($works as $work) {
            if ($limit > 0 && $changed >= $limit) {
                $this->warn("Stopped at --limit={$limit}.");
                break;
            }

            $html = $this->pageFor($work, $repair, $fetcher);
            if ($html === null) {
                $noPage++;
                continue;
            }

            $found = $repair->extractFromPage($html);
            if ($found === null) {
                $noDate++;
                continue;
            }
            if ((int) $found['year'] === (int) $work->year) {
                $agreed++;
                continue;
            }

            $changed++;
            $this->line(sprintf(
                '  %s  <fg=red>%s</> → <fg=green>%d</>  %s',
                $dry ? 'would fix' : 'fixed    ',
                $work->year ?? 'null',
                $found['year'],
                mb_substr($work->title ?? '(untitled)', 0, 62),
            ));

            if (! $dry) {
                $lanes = $repair->apply($work->id, $found);
                $this->line("             {$lanes} library row(s) updated");
            }
        }

        $this->newLine();
        $this->info(($dry ? 'Would fix ' : 'Fixed ') . "{$changed}; {$agreed} already correct; "
            . "{$noPage} with no stored page" . ($this->option('fetch') ? ' (fetch failed)' : ' (use --fetch)')
            . "; {$noDate} whose page carries no date.");

        if ($changed > 0 && ! $dry) {
            $this->newLine();
            $this->warn('Rendered feeds cache per shelf — drop the journal shelf renders so the new years show:');
            $this->line('  php artisan journal:harvest <slug> --max-works=0   # re-runs the shelf reconcile');
        }

        return 0;
    }

    /** The publisher page for a work: the one we stored, or a fresh fetch when asked for. */
    private function pageFor(object $work, PublisherYearRepair $repair, ContentFetchService $fetcher): ?string
    {
        // Any lane's stored page will do — they are pages of the same article, and the citation
        // meta is the publisher's, not the lane's.
        $books = DB::connection('pgsql_admin')->table('library')
            ->where('canonical_source_id', $work->id)
            ->where('visibility', '!=', 'deleted')
            ->pluck('book');

        foreach ($books as $book) {
            if (($html = $repair->storedPageFor($book)) !== null) {
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
}

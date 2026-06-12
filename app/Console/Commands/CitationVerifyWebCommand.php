<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Acquire + verify a non-academic web source: browser-fetch the cited URL,
 * confirm it IS the cited article (WebArticleVerifier), convert body+footnotes
 * via the paste engine, and persist with the verdict in conversion_method.
 *
 * Usage:
 *   php artisan citation:verify-web <book>            # a web_source library row
 *   php artisan citation:verify-web <book> --url=... --title=...   # explicit override
 */
class CitationVerifyWebCommand extends Command
{
    protected $signature = 'citation:verify-web {book : web_source library book id}
                            {--url= : override the URL to fetch}
                            {--title= : override the citation title to match against}';

    protected $description = 'Browser-fetch a web source, verify it is the cited article, and import body + footnotes.';

    public function handle(ContentFetchService $fetch): int
    {
        $bookId = $this->argument('book');
        $row = DB::connection('pgsql_admin')->table('library')->where('book', $bookId)->first(['url', 'title', 'type']);

        if (!$row) {
            $this->error("Library row not found: {$bookId}");
            return 1;
        }

        $url = $this->option('url') ?: $row->url;
        $title = $this->option('title') ?: $row->title;

        if (!$url) {
            $this->error('No URL on this row (and none given via --url).');
            return 1;
        }

        $this->info("URL:   {$url}");
        $this->info("Title: {$title}");
        $this->line('Browser-fetching + verifying…');

        $result = $fetch->importWebSource($url, $title, $bookId);

        $this->newLine();
        if ($result['status'] === 'imported') {
            $v = $result['web_verdict'];
            $this->info("Status: {$result['status']}");
            $this->line("  verdict: <fg=" . ($v['verdict'] === 'web_verified' ? 'green' : 'yellow') . ">{$v['verdict']}</> "
                . "(matched on {$v['matched_on']}, title score {$v['score']})");
            $this->line("  page title: " . ($v['page_title'] ?? '—'));
            $this->line("  {$result['reason']}");
        } else {
            $this->warn("Status: failed — {$result['reason']}");
        }

        return 0;
    }
}

<?php

namespace App\Console\Commands;

use App\Services\LlmService;
use App\Services\WebFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CitationWebFetchCommand extends Command
{
    protected $signature = 'citation:web-fetch {bookId : The parent book ID}';
    protected $description = 'Fetch web content for unverified citation sources that have URLs';

    public function handle(WebFetchService $webFetch): int
    {
        $bookId = $this->argument('bookId');
        $db = DB::connection('pgsql_admin');

        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        // Find bibliography entries with no resolved source
        $unknowns = $db->table('bibliography')
            ->where('book', $bookId)
            ->where('foundation_source', 'unknown')
            ->select(['referenceId', 'content'])
            ->get();

        if ($unknowns->isEmpty()) {
            $this->line('  No unverified sources to fetch.');
            return 0;
        }

        $this->line("  {$unknowns->count()} unverified source(s) to process.");
        $this->newLine();

        // Filter to entries that have a URL in their content
        $withUrls = $unknowns->filter(fn($bib) => $webFetch->extractUrl($bib->content ?? '') !== null);
        $noUrls = $unknowns->count() - $withUrls->count();

        if ($withUrls->isEmpty()) {
            $this->line("  None have fetchable URLs ({$noUrls} book/journal sources skipped).");
            return 0;
        }

        $this->line("  {$withUrls->count()} with URLs, {$noUrls} without (books/journals — skipped).");
        $this->newLine();

        // Use LLM for metadata extraction (standalone mode — no scan job context)
        $llm = app(LlmService::class);

        $fetched = 0;
        $failed = 0;

        foreach ($withUrls->values() as $i => $bib) {
            $content = $bib->content ?? '';
            $refId = $bib->referenceId;
            $url = $webFetch->extractUrl($content);

            // Extract metadata via LLM for clean title/author/year
            $llmMetadata = $llm->extractCitationMetadata($content);
            $title = $llmMetadata['title'] ?? null;
            $shortTitle = Str::limit($title ?: $refId, 60);

            $this->line("  <fg=cyan>[" . ($i + 1) . "/{$withUrls->count()}] {$shortTitle}</>");
            $this->line("    URL: {$url}");

            $text = $webFetch->fetchAndValidate($url, $title ?: 'Web Source');

            if ($text) {
                $this->line("    <fg=green>Fetched: " . strlen($text) . " chars (validated)</>");

                $stubAuthor = !empty($llmMetadata['authors']) ? implode('; ', $llmMetadata['authors']) : null;
                $stubYear   = $llmMetadata['year'] ?? null;
                $stubBookId = $webFetch->createWebStubWithNodes($db, $title, $stubAuthor, $stubYear, $text, $url);

                if ($stubBookId) {
                    $db->table('bibliography')
                        ->where('book', $bookId)
                        ->where('referenceId', $refId)
                        ->update(['foundation_source' => $stubBookId]);

                    $this->line("    <fg=green>Stub created: {$stubBookId}</>");
                    $fetched++;
                } else {
                    $this->line("    <fg=red>Stub creation failed</>");
                    $failed++;
                }
            } else {
                $this->line("    <fg=yellow>Fetch failed, too short, or content rejected</>");
                $failed++;
            }

            // Rate limit
            if ($i < $withUrls->count() - 1) {
                sleep(1);
            }
        }

        $this->newLine();
        $this->info("Web fetch complete: {$fetched} resolved, {$failed} failed, {$noUrls} skipped (no URL)");

        return 0;
    }
}

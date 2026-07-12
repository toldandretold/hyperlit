<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Run ONE url through the real ContentFetchService ladder and print a verbose
 * trace — the iteration tool for the Cloudflare-beating fetch pipeline. The
 * user's question "do we even have logs that we tried via the proxy?" is
 * answered here: which sticky session + proxy (masked), how many OA candidates,
 * which lane/host won, and whether real PDF bytes landed.
 *
 * Creates a throwaway library row so the real fetch()/OCR path runs, then
 * deletes it (and its nodes) unless --keep. This is also the canary for
 * patchright version bumps — re-run against the tandfonline PDF after upgrading.
 */
class HarvestTestFetchCommand extends Command
{
    protected $signature = 'harvest:test-fetch
        {url : The oa_url / pdf_url / landing to fetch}
        {--doi= : DOI (enables the JATS + DOI-referer + browser-landing lanes)}
        {--title= : Title, for the temp library row}
        {--keep : Keep the imported book instead of cleaning it up}';

    protected $description = 'Fetch one URL through the real ContentFetchService ladder with a verbose trace';

    public function handle(): int
    {
        $url = $this->argument('url');
        $doi = $this->option('doi');
        $isPdf = (bool) preg_match('#\.pdf(\?|$)|/pdf/#i', $url);

        $bookId = 'harvest-test-fetch-' . Str::random(10);
        $db = DB::connection('pgsql_admin');

        $db->table('library')->insert([
            'book'       => $bookId,
            'title'      => $this->option('title') ?: 'Harvest test fetch',
            'author'     => 'Test',
            'visibility' => 'private',
            'listed'     => false,
            'is_oa'      => true,
            'oa_url'     => $isPdf ? null : $url,
            'pdf_url'    => $isPdf ? $url : null,
            'doi'        => $doi,
            'raw_json'   => json_encode(['book' => $bookId]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->info("Temp book: {$bookId}");
        $this->line('  URL:  ' . $url . ($isPdf ? '  (as pdf_url)' : '  (as oa_url)'));
        if ($doi) $this->line('  DOI:  ' . $doi);
        $proxyConfigured = (bool) (config('services.source_fetch.proxy') ?: env('SOURCE_FETCH_PROXY'));
        $this->line('  Proxy configured: ' . ($proxyConfigured ? 'yes' : 'NO (fetching from server IP)'));
        $this->line('  Headed browser: ' . (config('services.source_fetch.headful') ? 'yes' : 'no (headless — will lose managed challenges)'));
        $this->newLine();
        $this->info('Running the fetch ladder…');
        $started = microtime(true);

        $service = app(ContentFetchService::class);
        $result = $service->fetch((object) $db->table('library')->where('book', $bookId)->first());
        $trace = $service->lastFetchTrace();
        $elapsed = round(microtime(true) - $started, 1);

        $this->newLine();
        $this->info('── Trace ──');
        $this->line('  Sticky session: ' . ($trace['session'] ?? '—'));
        $this->line('  Proxy (masked): ' . ($trace['proxy'] ?? 'none'));
        $this->line('  OA candidates tried: ' . $trace['candidates']);
        if ($trace['won_host']) {
            $this->line('  Won via: ' . $trace['won_host'] . ' (' . $trace['won_source'] . ')');
        }
        $this->line('  Elapsed: ' . $elapsed . 's');
        $this->newLine();

        $color = match ($result['status']) {
            'imported'   => 'green',
            'downloaded' => 'blue',
            'skipped'    => 'yellow',
            default      => 'red',
        };
        $this->line("<fg={$color}>Status: {$result['status']}</>");
        $this->line('  ' . $result['reason']);

        // Verify the bytes landed.
        $pdfPath = resource_path("markdown/{$bookId}/original.pdf");
        if (file_exists($pdfPath)) {
            $magic = @file_get_contents($pdfPath, false, null, 0, 5);
            $this->line('  PDF on disk: ' . number_format(filesize($pdfPath)) . ' bytes, magic '
                . ($magic === '%PDF-' ? '%PDF- ✅' : json_encode($magic) . ' ❌'));
        }
        $nodeCount = $db->table('nodes')->where('book', $bookId)->count();
        if ($nodeCount) {
            $this->line("  Nodes imported: {$nodeCount}");
        }

        // Cleanup unless kept.
        if ($this->option('keep')) {
            $this->newLine();
            $this->warn("Kept book {$bookId} (nodes: {$nodeCount}). Remember to delete it later.");
        } else {
            $db->table('nodes')->where('book', 'LIKE', $bookId . '%')->delete();
            $db->table('bibliography')->where('book', $bookId)->delete();
            $db->table('footnotes')->where('book', $bookId)->delete();
            $db->table('library')->where('book', 'LIKE', $bookId . '%')->delete();
            @\Illuminate\Support\Facades\File::deleteDirectory(resource_path("markdown/{$bookId}"));
            $this->newLine();
            $this->line('Cleaned up the temp book (use --keep to preserve).');
        }

        return $result['status'] === 'failed' ? 1 : 0;
    }
}

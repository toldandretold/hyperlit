<?php

namespace App\Console\Commands\Scrape;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * The first per-site scraper for the web-scrape import standard
 * (docs/web-scrape-import.md): ris.org.in's "Documents on Non-Aligned
 * Movement" page — six h5 sections (NAM, G-77, CHOGM, IBSA, BRICS, BIMSTEC),
 * each a plain <ul> of PDF links.
 *
 * Emits a ready-to-drop folder: the section's PDFs under stable slugified
 * filenames plus a manifest.json carrying per-document title / source URL /
 * year, which the folder-drop import applies to each book's library row.
 * Re-run friendly: already-downloaded files are skipped, the manifest is
 * rewritten. Sequential with a polite delay — this is an operator tool, not
 * a crawler.
 */
class RisDocsScrapeCommand extends Command
{
    protected $signature = 'scrape:ris-docs
        {outDir : Folder to write the PDFs + manifest.json into (created if absent)}
        {--section=NAM : Which h5 section of the page to scrape (NAM, G-77, IBSA, BRICS, BIMSTEC, ...)}
        {--author= : Author for every document (default: the section\'s organisation, see SECTION_AUTHORS)}
        {--delay=2 : Seconds to sleep between downloads}
        {--limit=0 : Stop after N documents (0 = all)}';

    protected $description = 'Scrape a section of ris.org.in\'s Non-Aligned Movement documents page into a drop-folder (PDFs + manifest.json)';

    private const PAGE_URL = 'https://www.ris.org.in/en/documents-non-aligned-movement';
    private const BASE_URL = 'https://www.ris.org.in';

    /**
     * These are institutional documents — summit declarations, final documents
     * — so the AUTHOR is the organisation, keyed by page section. Without an
     * author, the library card falls back to the importing user's name, which
     * reads as if the maintainer wrote the Durban Declaration.
     */
    private const SECTION_AUTHORS = [
        'NAM'    => 'Non-Aligned Movement (NAM)',
        'G-77'   => 'Group of 77 (G-77)',
        'IBSA'   => 'IBSA Dialogue Forum',
        'BRICS'  => 'BRICS',
        'BIMSTEC' => 'BIMSTEC',
        'Commonwealth Heads of Government Meetings (CHOGM)' => 'Commonwealth Heads of Government',
    ];
    private const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 hyperlit-archive-scraper';

    public function handle(): int
    {
        $outDir = rtrim((string) $this->argument('outDir'), '/');
        $section = (string) $this->option('section');
        $author = (string) ($this->option('author') ?: (self::SECTION_AUTHORS[$section] ?? ''));
        $delay = max(0, (int) $this->option('delay'));
        $limit = max(0, (int) $this->option('limit'));

        File::ensureDirectoryExists($outDir);

        $this->info('Fetching ' . self::PAGE_URL);
        $page = Http::withHeaders(['User-Agent' => self::USER_AGENT])->timeout(60)->get(self::PAGE_URL);
        if (!$page->ok()) {
            $this->error("Page fetch failed ({$page->status()}).");

            return self::FAILURE;
        }

        $links = $this->sectionLinks($page->body(), $section);
        if (empty($links)) {
            $this->error("No PDF links found under section \"{$section}\" — has the page structure changed?");

            return self::FAILURE;
        }
        $this->info(count($links) . " document(s) under \"{$section}\".");
        if ($limit > 0) {
            $links = array_slice($links, 0, $limit);
        }

        $documents = [];
        foreach ($links as $i => $link) {
            $filename = $this->filenameFor($link['title'], $i);
            $target = "{$outDir}/{$filename}";

            if (File::exists($target)) {
                $this->line("  = {$filename} (already downloaded)");
            } else {
                $this->line('  ↓ ' . Str::limit($link['title'], 80));
                $pdf = Http::withHeaders(['User-Agent' => self::USER_AGENT])->timeout(180)->get($link['url']);
                if (!$pdf->ok() || strlen($pdf->body()) < 1024) {
                    $this->warn("    fetch failed ({$pdf->status()}, " . strlen($pdf->body()) . ' bytes) — skipped');
                    continue;
                }
                File::put($target, $pdf->body());
                if ($delay) {
                    sleep($delay);
                }
            }

            $entry = [
                'title'    => $link['title'],
                'url'      => $link['url'],
                'language' => 'en',
            ];
            if ($author !== '') {
                $entry['author'] = $author;
            }
            if (preg_match('/\b(19[4-9]\d|20[0-4]\d)\b/', $link['title'], $m)) {
                $entry['year'] = (int) $m[1];
            }
            $documents[$filename] = $entry;
        }

        if (empty($documents)) {
            $this->error('Nothing downloaded.');

            return self::FAILURE;
        }

        $manifest = [
            'schema_version' => 1,
            'source' => [
                'site'       => 'ris.org.in',
                'scraper'    => 'scrape:ris-docs --section=' . $section,
                'page'       => self::PAGE_URL,
                'scraped_at' => now()->toIso8601String(),
            ],
            'documents' => $documents,
        ];
        File::put("{$outDir}/manifest.json", json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $this->info(count($documents) . " document(s) + manifest.json written to {$outDir} — drop the folder on /maintainer/shelf-import/{shelf}.");

        return self::SUCCESS;
    }

    /**
     * PDF links under one h5 section of the page's body field: everything
     * between `<h5>…{section}…</h5>` and the next h5 (or the body's end).
     *
     * @return array<int, array{title: string, url: string}>
     */
    private function sectionLinks(string $html, string $section): array
    {
        $bodyStart = strpos($html, 'field--name-body');
        $body = $bodyStart !== false
            ? substr($html, $bodyStart, (strpos($html, '</article>', $bodyStart) ?: strlen($html)) - $bodyStart)
            : $html;

        // Slice out the requested section.
        if (!preg_match_all('/<h5[^>]*>(.*?)<\/h5>/si', $body, $headings, PREG_OFFSET_CAPTURE)) {
            return [];
        }
        $sectionStart = null;
        $sectionEnd = strlen($body);
        foreach ($headings[0] as $idx => [$match, $offset]) {
            $text = trim(strip_tags($headings[1][$idx][0]));
            if ($sectionStart === null && strcasecmp($text, $section) === 0) {
                $sectionStart = $offset + strlen($match);
            } elseif ($sectionStart !== null) {
                $sectionEnd = $offset;
                break;
            }
        }
        if ($sectionStart === null) {
            return [];
        }
        $slice = substr($body, $sectionStart, $sectionEnd - $sectionStart);

        $links = [];
        if (preg_match_all('/<a\s[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>(.*?)<\/a>/si', $slice, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $href = html_entity_decode($m[1]);
                // The page mixes relative paths, absolute URLs and unencoded
                // spaces; normalise to an absolute, encoded URL.
                $url = str_starts_with($href, 'http') ? $href : self::BASE_URL . $href;
                $url = str_replace(' ', '%20', $url);
                $title = trim(preg_replace('/[\s\x{00A0}]+/u', ' ', strip_tags(html_entity_decode($m[2]))));
                if ($title === '') {
                    continue;
                }
                $links[] = ['title' => $title, 'url' => $url];
            }
        }

        return $links;
    }

    /** Stable slugified filename for a document — re-runs hit the same name. */
    private function filenameFor(string $title, int $index): string
    {
        $slug = Str::slug(Str::limit($title, 80, ''));

        return ($slug !== '' ? $slug : 'document-' . ($index + 1)) . '.pdf';
    }
}

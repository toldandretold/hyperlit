<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * Pull an already-imported library book into a study corpus: snapshot its
 * markdown into the corpus sources and append a manifest entry. The study
 * still runs on a fresh study_{corpus}_{slug} COPY (via citation:study:import),
 * never on the live book — that keeps the corpus hashable/frozen, the runs
 * billed to the study user, and the no-canonical-ids invariant intact (a live
 * canonicalized book is Wave 3-matchable and would contaminate ground truth).
 */
class StudyAdoptCommand extends Command
{
    protected $signature = 'citation:study:adopt
        {corpus : Corpus name (created if it does not exist)}
        {bookId : Library book to adopt}
        {--arm=control : synthetic | retracted | control}
        {--slug= : Corpus slug (default: derived from the book title)}
        {--seed=424242 : Corruption seed (synthetic arm)}';

    protected $description = 'Snapshot an already-imported book into a study corpus (copies its markdown + provenance into study/corpora/{corpus})';

    public function handle(): int
    {
        $corpus = $this->argument('corpus');
        $bookId = $this->argument('bookId');
        $arm = $this->option('arm');
        if (!in_array($arm, CorpusManifest::ARMS, true)) {
            $this->error("Invalid --arm '{$arm}' (synthetic | retracted | control).");
            return 1;
        }

        $book = DB::connection('pgsql_admin')->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        // Markdown imports keep original.md; PDF/EPUB conversions produce
        // main-text.md. Web/HTML imports have neither — for those, rebuild
        // markdown from the book's nodes via the app's exporter.
        $sourceMd = null;
        $markdownContent = null;
        $sourceLabel = null;
        foreach (['original.md', 'main-text.md'] as $candidate) {
            $path = resource_path("markdown/{$bookId}/{$candidate}");
            if (is_file($path)) {
                $sourceMd = $path;
                $sourceLabel = $candidate;
                break;
            }
        }
        // Numbered/Vancouver books whose in-text citations are pre-linked
        // anchors cannot survive a markdown round-trip: the markdown importer
        // only re-links AUTHOR-DATE patterns, and a bare "[6]" is claimed by
        // the footnote linker instead — the study copy silently ends up with
        // ZERO citations. Adopt those as HTML, which keeps the anchors intact.
        // (Synthetic-arm books must stay markdown: the corruptor edits text.)
        $htmlContent = null;
        if ($sourceMd === null && $arm !== 'synthetic' && $this->hasNumericCitationAnchors($bookId)) {
            $htmlContent = $this->htmlFromNodes($bookId);
            $sourceLabel = 'exported-from-nodes (html, pre-linked anchors preserved)';
            $this->line('Numbered-style citations detected — adopting as HTML so anchors survive.');
        }

        if ($sourceMd === null && $htmlContent === null) {
            $markdownContent = app(\App\Services\Export\BookMarkdownExporter::class)->markdownFor($bookId);
            if (trim((string) $markdownContent) === '') {
                $this->error("No markdown on disk for {$bookId} and its nodes exported empty — cannot adopt.");
                return 1;
            }
            // Internal citation anchors: reduce to plain text so the
            // re-import re-detects them from scratch. NUMERIC link text keeps
            // its brackets — "[6](#x)" must become "[6]", not "6", or the
            // Vancouver-style marker is unrecognisable on re-import (it
            // silently yields a book with zero citations).
            $markdownContent = preg_replace_callback(
                '/\[([^\]]+)\]\(#[^)]*\)/',
                function ($m) {
                    $text = $m[1];
                    return preg_match('/^\s*\d+(\s*[,–-]\s*\d+)*\s*$/', $text) ? "[{$text}]" : $text;
                },
                $markdownContent
            );
            // Bulleted reference entries ("- Alvero…" / exporter-escaped
            // "\- Alvero…") hide the author-year shape from the reference
            // processor on re-import — strip the bullets, refs section only.
            if (preg_match('/^#{1,6}\s*(references|bibliography|works\s+cited|reference\s+list)\s*$/mi', $markdownContent, $rm, PREG_OFFSET_CAPTURE)) {
                $cut = $rm[0][1];
                $refs = preg_replace('/^\\\\?-\s+/m', '', substr($markdownContent, $cut));
                $markdownContent = substr($markdownContent, 0, $cut) . $refs;
            }
            $sourceLabel = 'exported-from-nodes';
            $this->line('No markdown on disk — rebuilt it from the book\'s nodes.');
        }

        $slug = $this->option('slug') ?: rtrim(Str::slug(Str::limit($book->title ?? $bookId, 40, '')), '-');
        if (!preg_match('/^[a-zA-Z0-9_-]+$/', $slug)) {
            $this->error("Derived slug '{$slug}' is invalid — pass --slug explicitly.");
            return 1;
        }

        $corpusDir = base_path(config('study.root', 'study') . "/corpora/{$corpus}");
        $manifestPath = "{$corpusDir}/manifest.json";
        $manifest = is_file($manifestPath)
            ? json_decode((string) file_get_contents($manifestPath), true)
            : ['corpus' => $corpus, 'description' => '', 'created' => now()->toDateString(), 'frozen' => false, 'books' => []];

        if (!is_array($manifest)) {
            $this->error("Existing manifest is not valid JSON: {$manifestPath}");
            return 1;
        }
        if ($manifest['frozen'] ?? false) {
            $this->error("Corpus '{$corpus}' is frozen — adopting into it would invalidate the lock.");
            return 1;
        }
        foreach ($manifest['books'] ?? [] as $existing) {
            if (($existing['slug'] ?? null) === $slug) {
                $this->error("Corpus '{$corpus}' already has slug '{$slug}'.");
                return 1;
            }
            if (($existing['provenance']['source_book_id'] ?? null) === $bookId) {
                $this->error("Book {$bookId} is already in this corpus as '{$existing['slug']}'.");
                return 1;
            }
        }

        $sourceDir = "{$corpusDir}/sources/{$slug}";
        File::ensureDirectoryExists($sourceDir);
        $sourceName = $htmlContent !== null ? 'original.html' : 'original.md';
        if ($htmlContent !== null) {
            File::put("{$sourceDir}/original.html", $htmlContent);
        } elseif ($sourceMd !== null) {
            File::copy($sourceMd, "{$sourceDir}/original.md");
        } else {
            File::put("{$sourceDir}/original.md", $markdownContent);
        }

        $entry = [
            'slug' => $slug,
            'arm' => $arm,
            'source_file' => "sources/{$slug}/{$sourceName}",
            'ground_truth' => "sources/{$slug}/ground_truth.json",
            'default_label' => 'intact',
            'provenance' => [
                'title' => $book->title,
                'author' => $book->author,
                'year' => $book->year,
                'doi' => $book->doi ?? null,
                'url' => $book->url,
                'source_book_id' => $bookId,
                'source_markdown' => $sourceLabel,
                'adopted_at' => now()->toDateString(),
            ],
        ];

        if ($arm === 'synthetic') {
            $entry['study_file'] = "sources/{$slug}/corrupted.md";
            $entry['corruption_spec'] = "sources/{$slug}/corruption.json";
            if (!is_file("{$sourceDir}/corruption.json")) {
                File::put("{$sourceDir}/corruption.json", json_encode([
                    'seed' => (int) $this->option('seed'),
                    'counts' => ['fabrication' => 2, 'source_swap' => 1, 'claim_distortion' => 1],
                ], JSON_PRETTY_PRINT) . "\n");
            }
        }

        $manifest['books'][] = $entry;
        File::put($manifestPath, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");

        // Validate the result loads cleanly before declaring success.
        CorpusManifest::load($corpus);

        $this->info("Adopted {$bookId} into corpus '{$corpus}' as '{$slug}' ({$arm}).");
        $this->line("  source: {$sourceDir}/{$sourceName} (from {$sourceLabel})");
        if ($arm === 'synthetic') {
            $this->line("  corruption spec: {$sourceDir}/corruption.json (edit counts/seed if wanted)");
        }
        $this->newLine();
        $this->line('Next:');
        if ($htmlContent !== null) {
            $this->line('  (HTML source: ground truth is generated from the imported rows during import)');
        }
        $this->line("  php artisan citation:study:corrupt {$corpus}" . ($arm === 'synthetic' ? '' : '   (skeleton ground truth — verify labels by hand)'));
        $this->line("  php artisan citation:study:import {$corpus}");
        $this->line("  php artisan citation:study:run {$corpus}");
        return 0;
    }

    /** True when the book's in-text citation anchors are numeric (Vancouver style). */
    private function hasNumericCitationAnchors(string $bookId): bool
    {
        $rows = DB::connection('pgsql_admin')
            ->table('nodes')
            ->where('book', $bookId)
            ->where('content', 'like', '%in-text-citation%')
            ->limit(20)
            ->pluck('content');

        $numeric = 0;
        $total = 0;
        foreach ($rows as $content) {
            if (preg_match_all('/<a[^>]*class="[^"]*in-text-citation[^"]*"[^>]*>(.*?)<\/a>/is', $content, $m)) {
                foreach ($m[1] as $text) {
                    $total++;
                    if (preg_match('/^\s*\d+\s*$/', strip_tags($text))) {
                        $numeric++;
                    }
                }
            }
        }
        return $total > 0 && ($numeric / $total) > 0.5;
    }

    /** Rebuild a book's HTML from its nodes, in reading order. */
    private function htmlFromNodes(string $bookId): string
    {
        $nodes = DB::connection('pgsql_admin')
            ->table('nodes')
            ->where('book', $bookId)
            ->orderBy('chunk_id')
            ->orderBy('startLine')
            ->pluck('content');

        return "<html><body>\n" . $nodes->filter()->implode("\n") . "\n</body></html>\n";
    }
}

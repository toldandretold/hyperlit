<?php

namespace App\Services\Export;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Builds the "Obsidian vault" artifact: a zip with one .md per exportable
 * book plus a README carrying the archive citation and what was skipped.
 * Writes to a .work path, atomic-renames on success (a crashed build never
 * leaves a half-zip at the served path).
 */
class MarkdownVaultBuilder
{
    public function __construct(private readonly BookMarkdownExporter $exporter)
    {
    }

    /**
     * @param  callable(float):void  $onProgress  fraction 0..1
     * @return string final artifact path
     */
    public function build(ArchiveCorpus $corpus, string $workPath, string $finalPath, callable $onProgress): string
    {
        File::ensureDirectoryExists(dirname($workPath), 0755);
        @unlink($workPath);

        $zip = new \ZipArchive();
        if ($zip->open($workPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException("Cannot open zip at {$workPath}");
        }

        $root = $this->rootFolder($corpus);
        $zip->addFromString("{$root}/README.md", $this->readme($corpus));

        $total = max(1, count($corpus->books));
        $usedNames = [];
        foreach ($corpus->books as $i => $row) {
            $markdown = $this->exporter->markdownFor($row->book, obsidianLinks: true);
            if (trim($markdown) !== '') {
                $name = $this->dedupe($this->exporter->filenameFor($row), $usedNames);
                $zip->addFromString("{$root}/{$name}", $this->frontMatter($row->book, $corpus) . $markdown);
            }
            $onProgress(($i + 1) / $total);
        }

        if (!$zip->close()) {
            throw new \RuntimeException('Zip finalize failed');
        }
        if (!@rename($workPath, $finalPath)) {
            throw new \RuntimeException("Cannot move artifact to {$finalPath}");
        }

        return $finalPath;
    }

    /**
     * YAML front matter for one note — Obsidian reads it as the note's
     * Properties (searchable, usable by Dataview/Zotero-style workflows). The
     * work's citation details as stored on the library row, plus the way BACK:
     * `hyperlit` is the live version of this text, `archive` the page the
     * vault was exported from. Only fields the row actually has are written.
     */
    private function frontMatter(string $bookId, ArchiveCorpus $corpus): string
    {
        $lib = DB::connection('pgsql_admin')->table('library')->where('book', $bookId)
            ->first(['title', 'author', 'year', 'journal', 'volume', 'issue', 'pages', 'publisher', 'doi', 'url', 'license', 'license_url', 'slug', 'language']);
        if (!$lib) {
            return '';
        }

        $clean = fn ($v) => trim(preg_replace('/\s+/', ' ', strip_tags((string) $v)) ?? '');
        $authors = array_values(array_filter(array_map('trim', preg_split('/\s*;\s*/', $clean($lib->author)) ?: [])));
        $doi = $clean($lib->doi);
        $license = $clean($lib->license);

        $fields = [
            'title' => $clean($lib->title),
            'authors' => $authors,
            'year' => $clean($lib->year),
            'journal' => $clean($lib->journal),
            'volume' => $clean($lib->volume),
            'issue' => $clean($lib->issue),
            'pages' => $clean($lib->pages),
            'publisher' => $clean($lib->publisher),
            'doi' => $doi,
            'source' => $clean($lib->url) ?: ($doi !== '' ? 'https://doi.org/' . $doi : ''),
            'language' => $clean($lib->language),
            // 'Unknown' is the absence of a licence, not one to assert.
            'license' => $license !== '' && $license !== \App\Support\Licenses::UNKNOWN ? $license : '',
            'license_url' => $clean($lib->license_url),
            'hyperlit' => url(\App\Helpers\BookSlugHelper::canonicalPath($bookId, $lib->slug ?: null)),
            'archive' => $corpus->pageUrl,
            'exported' => now()->toDateString(),
        ];

        $quote = fn (string $v) => '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $v) . '"';
        $lines = ['---'];
        foreach ($fields as $key => $value) {
            if ($value === '' || $value === []) {
                continue;
            }
            if (is_array($value)) {
                $lines[] = "{$key}:";
                foreach ($value as $item) {
                    $lines[] = '  - ' . $quote($item);
                }
            } else {
                $lines[] = "{$key}: " . $quote($value);
            }
        }
        $lines[] = '---';

        return implode("\n", $lines) . "\n\n";
    }

    private function rootFolder(ArchiveCorpus $corpus): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', preg_replace('/[<>:"\/\\\\|?*]/', '', $corpus->displayName) ?? '') ?? '');

        return ($clean !== '' ? $clean : $corpus->scopeId) . ' — Hyperlit ' . $corpus->noun();
    }

    private function readme(ArchiveCorpus $corpus): string
    {
        $lines = [
            '# ' . $corpus->brandedTitle(),
            '',
            'Exported from ' . $corpus->pageUrl . ' on ' . now()->toDateString() . '.',
            '',
            '- ' . count($corpus->books) . ' text' . (count($corpus->books) === 1 ? '' : 's') . ' in this vault, one Markdown file each.',
            '- Each file opens with its citation details as properties (front matter), including `hyperlit` — the link back to the live text.',
            '- Footnotes and hypercite links are resolved into `[^n]` footnotes; in-text citations link to their bibliography entry.',
            '- Images are linked at their hyperlit URLs (not bundled in the zip).',
        ];

        if ($corpus->encryptedBooks !== []) {
            $lines[] = '';
            $lines[] = '## Not included';
            $lines[] = '';
            $lines[] = 'These books are end-to-end encrypted — the server only holds ciphertext and cannot export them. Open them in your browser (where they decrypt) and use the per-book download instead:';
            $lines[] = '';
            foreach ($corpus->encryptedBooks as $row) {
                $lines[] = '- ' . (trim((string) ($row->title ?? '')) ?: $row->book);
            }
        }

        return implode("\n", $lines) . "\n";
    }

    private function dedupe(string $filename, array &$used): string
    {
        $candidate = $filename;
        $i = 2;
        while (isset($used[mb_strtolower($candidate)])) {
            $dot = strrpos($filename, '.');
            $candidate = $dot === false
                ? "{$filename} ({$i})"
                : substr($filename, 0, $dot) . " ({$i})" . substr($filename, $dot);
            $i++;
        }
        $used[mb_strtolower($candidate)] = true;

        return $candidate;
    }
}

<?php

namespace App\Services\Export;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Builds the "Obsidian vault" artifact: a zip with one .md per exportable
 * book plus a README carrying the archive citation and what was skipped, and
 * `references.bib` (VaultBibliography) — one entry per note, keyed by the
 * same `citekey` each note carries, so the shelf can be cited from with
 * Obsidian's citation plugins or imported into Zotero.
 * Writes to a .work path, atomic-renames on success (a crashed build never
 * leaves a half-zip at the served path).
 */
class MarkdownVaultBuilder
{
    /** Pending note bytes that trigger a zip flush — the build's memory ceiling. */
    public const FLUSH_BYTES = 8 * 1024 * 1024;

    /**
     * Which editor the vault is written for. The texts and references.bib are
     * the same; what differs is the syntax only one of them understands:
     *   - obsidian: in-text citations are block links (`#^id`) to their
     *     bibliography entry, and each note carries an `@citekey` alias;
     *   - zettlr: neither exists there (a `#^id` link resolves as a file path),
     *     so in-text citations are plain text and there are no aliases.
     */
    public const FLAVOR_OBSIDIAN = 'obsidian';

    public const FLAVOR_ZETTLR = 'zettlr';

    private string $flavor = self::FLAVOR_OBSIDIAN;

    /** @var array<string, string> book id => note filename, for the build in progress */
    private array $names = [];

    /** @var array<string, string> canonical_source_id => a vault book that is a version of it */
    private array $byCanonical = [];

    /** The vault's bibliography, at its root beside the README. */
    public const BIB_FILE = 'references.bib';

    /** Overridable so a test can force a flush between every note. */
    public int $flushBytes = self::FLUSH_BYTES;

    public function __construct(private readonly BookMarkdownExporter $exporter)
    {
    }

    /**
     * @param  callable(float):void  $onProgress  fraction 0..1
     * @return string final artifact path
     */
    public function build(ArchiveCorpus $corpus, string $workPath, string $finalPath, callable $onProgress, string $flavor = self::FLAVOR_OBSIDIAN): string
    {
        $this->flavor = $flavor;

        File::ensureDirectoryExists(dirname($workPath), 0755);
        @unlink($workPath);

        $zip = new \ZipArchive();
        if ($zip->open($workPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException("Cannot open zip at {$workPath}");
        }

        $root = $this->rootFolder($corpus);

        // Note names first: the hub note links to the readings BY NAME.
        $usedNames = ['readme.md' => true];
        $names = [];
        foreach ($corpus->books as $row) {
            $names[$row->book] = $this->dedupe($this->exporter->filenameFor($row), $usedNames);
        }

        $this->names = $names;
        $this->byCanonical = [];
        foreach (array_chunk(array_keys($names), 1000) as $ids) {
            $rows = DB::connection('pgsql_admin')->table('library')->whereIn('book', $ids)
                ->whereNotNull('canonical_source_id')->get(['book', 'canonical_source_id']);
            foreach ($rows as $r) {
                $this->byCanonical[$r->canonical_source_id] ??= $r->book;
            }
        }

        $zip->addFromString("{$root}/README.md", $this->hubOrReadme($corpus, $names));

        // ZipArchive keeps every addFromString() payload in memory until
        // close(), so an unflushed build peaks at the WHOLE corpus's markdown.
        // Close + reopen (append) once the pending notes pass FLUSH_BYTES:
        // peak is then one flush window, whatever the corpus size.
        $pending = 0;
        $total = max(1, count($corpus->books));
        $bibliography = new VaultBibliography();
        foreach ($corpus->books as $i => $row) {
            $markdown = $this->noteMarkdown($row->book);
            if (trim($markdown) !== '') {
                $lib = $this->libraryRow($row->book);
                $citekey = null;
                if ($lib) {
                    $citekey = $bibliography->citekeyFor($lib);
                    $bibliography->add($citekey, $lib, $this->hyperlitUrl($lib), $names[$row->book]);
                }
                $note = $this->frontMatter($row->book, $corpus, $lib, $citekey) . $markdown;
                $zip->addFromString("{$root}/{$names[$row->book]}", $note);
                $pending += strlen($note);
                unset($note);
            }
            unset($markdown);
            if ($pending >= $this->flushBytes) {
                if (!$zip->close()) {
                    throw new \RuntimeException('Zip flush failed');
                }
                if ($zip->open($workPath) !== true) {
                    throw new \RuntimeException("Cannot reopen zip at {$workPath}");
                }
                $pending = 0;
            }
            $onProgress(($i + 1) / $total);
        }

        if (!$bibliography->isEmpty()) {
            $zip->addFromString("{$root}/" . self::BIB_FILE, $bibliography->render());
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
     *
     * `citekey` is this work's key in references.bib, and the `@citekey` alias
     * makes the NOTE answer to it: `[@barnet2009idiomedia]` cites the work,
     * `[[@barnet2009idiomedia]]` links the vault's copy of it.
     */
    private function frontMatter(string $bookId, ArchiveCorpus $corpus, ?object $lib = null, ?string $citekey = null): string
    {
        $lib ??= $this->libraryRow($bookId);
        if (!$lib) {
            return '';
        }

        $clean = fn ($v) => trim(preg_replace('/\s+/', ' ', strip_tags((string) $v)) ?? '');
        $authors = array_values(array_filter(array_map('trim', preg_split('/\s*;\s*/', $clean($lib->author)) ?: [])));
        $doi = $clean($lib->doi);
        $license = $clean($lib->license);

        $fields = [
            'title' => $clean($lib->title),
            'citekey' => (string) $citekey,
            'aliases' => $citekey && $this->flavor === self::FLAVOR_OBSIDIAN ? ['@' . $citekey] : [],
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
            'hyperlit' => $this->hyperlitUrl($lib),
            // The book's ID, which never changes — `hyperlit` above is built
            // from the slug when there is one, and a slug can be renamed. This
            // is what lets a vault dropped back into Hyperlit find its books
            // again (App\Services\DocumentImport\VaultBookResolver).
            'book' => (string) $lib->book,
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

    private function noteMarkdown(string $bookId): string
    {
        $noteLinks = $this->citedNotes($bookId);

        return $this->flavor === self::FLAVOR_ZETTLR
            ? $this->exporter->markdownFor($bookId, plainFragmentLinks: true, noteLinks: $noteLinks)
            : $this->exporter->markdownFor($bookId, obsidianLinks: true, noteLinks: $noteLinks);
    }

    /**
     * Where each of one text's references can be FOLLOWED: refId => link target.
     *
     * First choice is the cited text's own note in this vault — the reference
     * was resolved to a library book by citation matching (`source_id` /
     * `foundation_source`), or shares a canonical work with a book here (the
     * vault may hold another version of it).
     *
     * The Zettlr vault then falls back to the work's DOI, else a URL the
     * reference itself carries: Zettlr has no paragraph anchor, so without
     * this a citation of a work outside the vault is dead text. Obsidian keeps
     * its block link to the bibliography entry for those (the hover shows the
     * whole reference, link included). A reference with nothing to point at is
     * left out and stays as it was.
     *
     * Each link carries the reference's own text as its title — the hover in
     * any editor, and what lets a re-import recognise the link as a citation
     * of that reference again (ResolveVaultCitationLinks in app/Python).
     *
     * @return array<string, array{href: string, title: string}>
     */
    private function citedNotes(string $bookId): array
    {
        $external = $this->flavor === self::FLAVOR_ZETTLR;
        $rows = DB::connection('pgsql_admin')->table('bibliography as b')
            ->leftJoin('canonical_source as c', 'c.id', '=', 'b.canonical_source_id')
            ->where('b.book', $bookId)
            ->get(['b.referenceId', 'b.source_id', 'b.foundation_source', 'b.canonical_source_id', 'b.content', 'b.llm_metadata', 'c.doi as canonical_doi']);

        $links = [];
        foreach ($rows as $r) {
            foreach ([$r->source_id, $r->foundation_source, $this->byCanonical[$r->canonical_source_id ?? ''] ?? null] as $candidate) {
                if ($candidate !== null && $candidate !== $bookId && isset($this->names[$candidate])) {
                    $links[$r->referenceId] = ['href' => rawurlencode($this->names[$candidate]), 'title' => self::linkTitle($r)];

                    continue 2;
                }
            }
            if ($external && ($url = self::externalLink($r)) !== null) {
                $links[$r->referenceId] = ['href' => $url, 'title' => self::linkTitle($r)];
            }
        }

        return $links;
    }

    /**
     * A reference's text as a Markdown link title. Quotes would end the title
     * and emphasis marks or brackets are read as markup by simpler parsers;
     * none of them matter to a reader or to the re-import, which compares
     * letters and digits only.
     */
    private static function linkTitle(object $row): string
    {
        $text = html_entity_decode(strip_tags((string) $row->content), ENT_QUOTES | ENT_HTML5);
        $text = str_replace(['"', '“', '”'], "'", $text);
        $text = trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/[*_`\[\]<>\\\\]/', '', $text)));

        return mb_strlen($text) > 300 ? rtrim(mb_substr($text, 0, 300)) : $text;
    }

    /** A reference's DOI (matched work, extracted metadata, or printed in the entry), else its URL. */
    private static function externalLink(object $row): ?string
    {
        $meta = json_decode((string) ($row->llm_metadata ?? ''), true) ?: [];
        // Hrefs count as well as the printed text: a publisher's entry often links "[Crossref]".
        $text = html_entity_decode(preg_replace('/<a\b[^>]*\bhref="([^"]*)"[^>]*>/i', ' $1 ', (string) $row->content) ?? '');
        $text = strip_tags($text);

        $doi = trim((string) ($row->canonical_doi ?? '')) ?: trim((string) ($meta['doi'] ?? ''));
        if ($doi === '' && preg_match('~\b(10\.\d{4,9}/[^\s"<>]+)~', $text, $m)) {
            $doi = $m[1];
        }
        $url = '';
        if ($doi !== '') {
            $doi = (string) preg_replace('~^(https?://(dx\.)?doi\.org/|doi:\s*)~i', '', $doi);
            $url = 'https://doi.org/' . rtrim($doi, '.,;:)]');
        } elseif (preg_match('~^https?://\S+$~i', trim((string) ($meta['url'] ?? '')))) {
            $url = trim($meta['url']);
        } elseif (preg_match('~https?://[^\s"<>]+~i', $text, $m)) {
            $url = rtrim($m[0], '.,;:)]');
        }

        // Parentheses and spaces would end the markdown link target early.
        return $url === '' ? null : str_replace(['(', ')', ' '], ['%28', '%29', '%20'], $url);
    }

    private function libraryRow(string $bookId): ?object
    {
        return DB::connection('pgsql_admin')->table('library')->where('book', $bookId)
            ->first(['book', 'title', 'author', 'year', 'journal', 'volume', 'issue', 'pages', 'publisher', 'doi', 'url', 'license', 'license_url', 'slug', 'language', 'type']);
    }

    private function hyperlitUrl(object $lib): string
    {
        return url(\App\Helpers\BookSlugHelper::canonicalPath($lib->book, $lib->slug ?: null));
    }

    /**
     * The vault's top note. With a HUB text (a shelf's overview book / an
     * archive's About book — ArchiveCorpus::$hub) the README *is* that text:
     * the course intro / reading-list readme, with its links to the shelf's
     * readings pointed at the notes in this vault, and the export details as a
     * footer. Without one it is the generated README.
     *
     * @param  array<string, string>  $names  book id => note filename
     */
    private function hubOrReadme(ArchiveCorpus $corpus, array $names): string
    {
        $readme = $this->readme($corpus);
        if (!$corpus->hub) {
            return $readme;
        }
        $body = trim($this->noteMarkdown($corpus->hub->book));
        if ($body === '') {
            return $readme;
        }

        $quote = fn (string $v) => '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $v) . '"';
        $front = implode("\n", [
            '---',
            'title: ' . $quote($corpus->displayName),
            'hyperlit: ' . $quote($corpus->pageUrl),
            'exported: ' . $quote(now()->toDateString()),
            '---',
        ]);
        // A pinned overview BOOK standing in as the README is still that work:
        // only its file name changes — it keeps its own citation front matter
        // and its own link back. (The page's About book is not a work; it
        // takes the collection's.)
        if (!str_starts_with($corpus->hub->book, \App\Services\Archives\ArchiveAboutBook::PREFIX)) {
            $own = trim($this->frontMatter($corpus->hub->book, $corpus));
            $front = $own !== '' ? $own : $front;
        }

        // The generated README minus its H1 becomes the footer.
        $details = trim((string) preg_replace('/\A# .*\R+/', '', $readme));

        return $front . "\n\n" . $this->linkReadings($body, $corpus, $names)
            . "\n\n---\n\n## About this vault\n\n" . $details . "\n";
    }

    /**
     * Point the hub's links to this collection's readings at their notes: a
     * markdown link whose target is a hyperlit URL (absolute on this site, or
     * site-relative) for a book in the vault — by id or slug — becomes a link
     * to that note's file. Everything else (other sites, books not in the
     * vault, in-note `#` links) is left exactly as written.
     */
    private function linkReadings(string $markdown, ArchiveCorpus $corpus, array $names): string
    {
        $byKey = [];
        foreach ($corpus->books as $row) {
            if (!isset($names[$row->book])) {
                continue;
            }
            $byKey[$row->book] = $names[$row->book];
            if (!empty($row->slug)) {
                $byKey[$row->slug] = $names[$row->book];
            }
        }
        if ($byKey === []) {
            return $markdown;
        }
        $host = parse_url((string) config('app.url'), PHP_URL_HOST);

        return preg_replace_callback(
            '/\]\(<?((?:https?:\/\/([^\/)\s]+))?\/([^\/)#?\s>]+)[^)\s>]*)>?\)/',
            function ($m) use ($byKey, $host) {
                if (($m[2] ?? '') !== '' && strcasecmp($m[2], (string) $host) !== 0) {
                    return $m[0]; // another site
                }
                $key = rawurldecode(str_replace('\\', '', $m[3]));
                if (!isset($byKey[$key])) {
                    return $m[0];
                }

                // Obsidian resolves a markdown link to a note by its (encoded) file name.
                return '](' . rawurlencode($byKey[$key]) . ')';
            },
            $markdown
        ) ?? $markdown;
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
            $this->flavor === self::FLAVOR_ZETTLR
                ? '- `' . self::BIB_FILE . '` holds one BibTeX entry per text, keyed by the `citekey` in that text\'s properties. In Zettlr, set it as the citation database (Preferences → Citations) and type `@` to cite these texts as `[@citekey]`.'
                : '- `' . self::BIB_FILE . '` holds one BibTeX entry per text, keyed by the `citekey` in that text\'s properties. Point an Obsidian citation plugin at it, or import it into Zotero, to cite these texts as `[@citekey]`; `[[@citekey]]` links to the text\'s note in this vault.',
            $this->flavor === self::FLAVOR_ZETTLR
                ? '- Footnotes and hypercite links are resolved into `[^n]` footnotes. An in-text citation of a text that is also in this vault links to that text\'s file; otherwise it links to the work\'s DOI or URL where the reference has one, and is plain text where it has none.'
                : '- Footnotes and hypercite links are resolved into `[^n]` footnotes. An in-text citation of a text that is also in this vault links to that text\'s note; the others link to their bibliography entry.',
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

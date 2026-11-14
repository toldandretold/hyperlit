<?php

namespace App\Services\Export;

use Illuminate\Support\Str;

/**
 * The vault's `references.bib`: one BibTeX entry per note, so the shelf can be
 * CITED from — Obsidian's citation plugins read a .bib directly, and Zotero
 * imports one (File → Import) as a collection.
 *
 * Entries are generated from the library row's citation columns rather than
 * copied from `library.bibtex`: that column is absent on a third of rows and
 * its keys are machine ids (`book_1789566169997`, `W1987282744`) nobody can
 * type. The key minted here — `barnet2009idiomedia` — is what a writer types
 * as `[@barnet2009idiomedia]`, and it is the SAME string the note carries as
 * its `citekey` property and `@citekey` alias, which is what ties the
 * reference to the vault's own copy of the text.
 *
 * `url` is the hyperlit link (where the copy that was read lives); the DOI is
 * kept beside it for the publisher's version. `file` names the note, relative
 * to the .bib, so a Zotero import can attach it.
 */
class VaultBibliography
{
    /** Title words too empty to name a work by. */
    private const STOP_WORDS = ['a', 'an', 'the', 'of', 'on', 'in', 'and', 'for', 'to', 'from', 'with', 'is', 'as', 'at', 'by', 'le', 'la', 'les', 'der', 'die', 'das', 'el', 'los', 'las', 'de'];

    /** @var array<string, true> */
    private array $used = [];

    /** @var string[] */
    private array $entries = [];

    /** A unique, typeable key for one work: `{surname}{year}{firstTitleWord}`. */
    public function citekeyFor(object $row): string
    {
        $authors = self::authors((string) ($row->author ?? ''));
        $surname = $authors === [] ? '' : self::surname($authors[0]);

        $titleWord = '';
        foreach (preg_split('/[^a-z0-9]+/', self::slug((string) ($row->title ?? ''), keep: ' ')) ?: [] as $word) {
            if ($word !== '' && !in_array($word, self::STOP_WORDS, true)) {
                $titleWord = $word;
                break;
            }
        }

        $year = preg_match('/\d{4}/', (string) ($row->year ?? ''), $m) ? $m[0] : '';
        $base = self::slug($surname) . $year . $titleWord;
        if ($base === '') {
            $base = self::slug((string) $row->book) ?: 'work';
        }
        // A key must not open with a digit for every BibTeX reader to take it.
        if (ctype_digit($base[0])) {
            $base = 'w' . $base;
        }

        $key = $base;
        for ($suffix = 'b'; isset($this->used[$key]); $suffix++) {
            $key = $base . $suffix;
        }
        $this->used[$key] = true;

        return $key;
    }

    /**
     * @param  object  $lib  library row (title, author, year, journal, volume,
     *   issue, pages, publisher, doi, language, type)
     */
    public function add(string $citekey, object $lib, string $hyperlitUrl, string $noteFilename): void
    {
        $clean = fn ($v) => trim(preg_replace('/\s+/', ' ', strip_tags((string) $v)) ?? '');
        $journal = $clean($lib->journal ?? '');
        $publisher = $clean($lib->publisher ?? '');

        $type = match (true) {
            $journal !== '' => 'article',
            ($lib->type ?? '') === 'dissertation' => 'phdthesis',
            ($lib->type ?? '') === 'report' => 'techreport',
            $publisher !== '' => 'book',
            default => 'misc',
        };

        $fields = [
            'author' => implode(' and ', array_map(self::escape(...), self::authors($clean($lib->author ?? '')))),
            'title' => self::escape($clean($lib->title ?? '')),
            'year' => self::escape($clean($lib->year ?? '')),
            'journal' => self::escape($journal),
            'volume' => self::escape($clean($lib->volume ?? '')),
            'number' => self::escape($clean($lib->issue ?? '')),
            'pages' => self::escape($clean($lib->pages ?? '')),
            // BibTeX wants an institution for a thesis / report, a publisher for a book.
            ($type === 'phdthesis' ? 'school' : ($type === 'techreport' ? 'institution' : 'publisher')) => self::escape($publisher),
            'doi' => self::raw($clean($lib->doi ?? '')),
            'url' => self::raw($hyperlitUrl),
            'langid' => self::raw($clean($lib->language ?? '')),
            'file' => self::raw($noteFilename),
        ];

        $lines = ["@{$type}{{$citekey},"];
        foreach ($fields as $name => $value) {
            if ($value !== '') {
                $lines[] = "  {$name} = {{$value}},";
            }
        }
        $lines[] = '}';
        $this->entries[] = implode("\n", $lines);
    }

    public function isEmpty(): bool
    {
        return $this->entries === [];
    }

    public function render(): string
    {
        return implode("\n\n", $this->entries) . "\n";
    }

    /**
     * library.author → individual names. `;` separates authors where present;
     * otherwise ` and `. Anonymous creators are stored as UUIDs — not a name.
     *
     * @return string[]
     */
    private static function authors(string $author): array
    {
        $author = trim($author);
        if ($author === '' || preg_match('/^[0-9a-fA-F-]{36}$/', $author)) {
            return [];
        }
        $parts = str_contains($author, ';')
            ? preg_split('/\s*;\s*/', $author)
            : preg_split('/\s+and\s+/i', $author);

        return array_values(array_filter(array_map('trim', $parts ?: [])));
    }

    /** "Barnet, Belinda" → Barnet; "Belinda Barnet" → Barnet. */
    private static function surname(string $name): string
    {
        if (str_contains($name, ',')) {
            return trim(explode(',', $name)[0]);
        }
        $tokens = preg_split('/\s+/', trim($name)) ?: [];

        return (string) end($tokens);
    }

    private static function slug(string $s, string $keep = ''): string
    {
        return (string) preg_replace('/[^a-z0-9' . preg_quote($keep, '/') . ']+/', '', mb_strtolower(Str::ascii($s)));
    }

    /** Prose field: unbalanced braces would end the entry early; the rest are TeX specials. */
    private static function escape(string $v): string
    {
        return (string) preg_replace('/([&%$#_])/', '\\\\$1', str_replace(['\\', '{', '}'], '', $v));
    }

    /** Verbatim field (url, doi, file): only what would break the entry's own braces. */
    private static function raw(string $v): string
    {
        return str_replace(['{', '}'], '', $v);
    }
}

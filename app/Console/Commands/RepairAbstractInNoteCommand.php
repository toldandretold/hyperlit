<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Move an article ABSTRACT that was filed as a citation NOTE into
 * `library.abstract`, where it belongs.
 *
 * How it got there: the cite form and the source panel autofilled a pasted
 * BibTeX entry with unanchored per-field regexes, so `/note\s*=/` matched the
 * TAIL of OJS's `abstractNote={…}` and a whole abstract landed in the Note
 * field. `generateBibtexFromForm` then wrote it into `library.bibtex` as
 * `note = {…}`, and LibraryCardGenerator::generateHtmlCitation renders `note`
 * last — inside the citation — so the abstract appeared on every
 * server-generated library card (home feeds, user page, shelves, journal).
 * Fixed at the source in `resources/js/utilities/bibtexProcessor.ts`
 * (AUTOFILL_FIELD_BY_BIBTEX_KEY maps exact keys now); this repairs the rows
 * already written.
 *
 * The wrong column costs real things, which is why this moves rather than just
 * clears: `library.abstract` is what `TextController::buildSeoData` renders as
 * the book page's `<meta name="description">` and JSON-LD `abstract`, and what
 * CanonicalSourceMatcher reads when matching versions to a canonical source.
 *
 * Publisher abstracts arrive entity-escaped — OJS escapes TWICE
 * (`&amp;lt;p&amp;gt;`), which `strip_tags` cannot touch because there is no
 * `<` left to see. Decoding runs to a fixed point before the tags come out.
 *
 * Conservative by construction: only a note that is LONG (>= --min-length) or
 * carries markup is treated as an abstract, an existing `abstract` is never
 * overwritten without --force, and a `note = {…}` field is removed from the
 * stored bibtex only when it holds that same text.
 *
 * Test coverage: tests/Unit/RepairAbstractInNoteTest.php
 */
class RepairAbstractInNoteCommand extends Command
{
    protected $signature = 'library:repair-abstract-in-note
                            {--book= : Repair one book id only}
                            {--min-length=400 : Shortest note length treated as an abstract}
                            {--force : Overwrite a non-empty library.abstract}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = 'Move abstracts mis-filed into library.note (from a pasted BibTeX abstractNote) into library.abstract.';

    public function handle(): int
    {
        $dryRun = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');
        $minLength = max(1, (int) $this->option('min-length'));

        $db = DB::connection('pgsql_admin');

        $query = $db->table('library')
            ->whereNotNull('note')
            ->where('note', '!=', '')
            ->select(['book', 'note', 'abstract', 'bibtex']);

        if ($book = $this->option('book')) {
            $query->where('book', $book);
        }

        $moved = 0;
        $skipped = 0;
        $bibtexCleaned = 0;

        foreach ($query->orderBy('book')->cursor() as $row) {
            if (!$this->looksLikeAnAbstract($row->note, $minLength)) {
                continue;
            }

            if (!empty($row->abstract) && !$force) {
                $this->warn("skip {$row->book} — abstract already set (use --force)");
                $skipped++;
                continue;
            }

            $abstract = self::cleanAbstract($row->note);
            if ($abstract === '') {
                $this->warn("skip {$row->book} — note decodes to nothing");
                $skipped++;
                continue;
            }

            $update = ['note' => null, 'abstract' => $abstract];

            // The bibtex is what cards actually render, so a stale `note` field
            // there would keep printing after the column is cleared.
            if ($row->bibtex && self::bibtexNoteMatches($row->bibtex, $row->note)) {
                $update['bibtex'] = self::removeBibtexField($row->bibtex, 'note');
                $bibtexCleaned++;
            }

            $this->line(sprintf(
                '%s %s — %d chars of note → abstract%s',
                $dryRun ? 'would move' : 'moved',
                $row->book,
                strlen($row->note),
                isset($update['bibtex']) ? ' (+ bibtex note removed)' : '',
            ));

            if (!$dryRun) {
                // meta_updated_at is trigger-maintained, so clearing the bibtex
                // note is enough to make the home/user feeds rebuild themselves.
                $db->table('library')->where('book', $row->book)->update($update);
            }
            $moved++;
        }

        $this->info(sprintf(
            '%s: %d moved, %d bibtex notes removed, %d skipped.',
            $dryRun ? 'Dry run' : 'Done',
            $moved,
            $bibtexCleaned,
            $skipped,
        ));

        return self::SUCCESS;
    }

    /**
     * A citation note is a line ("Reprinted with a new preface"); an abstract is
     * a paragraph, and a pasted one usually still wears its escaped markup.
     */
    private function looksLikeAnAbstract(string $note, int $minLength): bool
    {
        if (strlen($note) >= $minLength) {
            return true;
        }

        return (bool) preg_match('/&(?:amp;)*lt;\s*\/?\s*(?:p|div|span|br)\b/i', $note)
            || (bool) preg_match('/<\s*\/?\s*(?:p|div|span|br)\b/i', $note);
    }

    /**
     * Entity-decode to a fixed point, then strip tags. OJS escapes its abstract
     * HTML twice, so one `html_entity_decode` leaves `&lt;p&gt;` behind and
     * `strip_tags` sees no tags at all.
     */
    public static function cleanAbstract(string $raw): string
    {
        $text = $raw;
        for ($i = 0; $i < 4; $i++) {
            $decoded = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($decoded === $text) {
                break;
            }
            $text = $decoded;
        }

        // Paragraph breaks become blank lines rather than running words together.
        $text = preg_replace('/<\s*\/\s*p\s*>\s*/i', "\n\n", $text) ?? $text;
        $text = preg_replace('/<\s*br\s*\/?\s*>/i', "\n", $text) ?? $text;
        $text = strip_tags($text);
        $text = preg_replace('/[ \t]+/', ' ', $text) ?? $text;
        $text = preg_replace('/\n{3,}/', "\n\n", $text) ?? $text;

        return trim($text);
    }

    /** Does the entry's `note` field hold this same text? (Exact key, not a tail match.) */
    public static function bibtexNoteMatches(string $bibtex, string $note): bool
    {
        if (!preg_match('/(?:^|[,{\s])note\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/i', $bibtex, $m)) {
            return false;
        }

        return trim($m[1]) === trim($note);
    }

    /**
     * Remove one field (with its trailing comma) from a BibTeX entry.
     *
     * Removing the LAST field leaves the previous field's comma dangling in
     * front of the closing brace. Our own `buildBibtexEntry` emits that shape
     * and every parser here tolerates it, but a repaired entry also leaves for
     * users' reference managers through the archive export, so close it.
     */
    public static function removeBibtexField(string $bibtex, string $field): string
    {
        $pattern = '/(^|[,{\s])' . preg_quote($field, '/') . '\s*=\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*,?/i';
        $out = preg_replace($pattern, '$1', $bibtex, 1);
        if ($out === null || $out === $bibtex) {
            return $bibtex;
        }

        return preg_replace('/,(\s*)\}\s*$/', '$1}', $out) ?? $out;
    }
}

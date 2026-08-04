<?php

namespace App\Services\Conversion;

use App\Models\ConversionFlag;
use App\Services\BookDeletionService;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use Illuminate\Support\Facades\DB;

/**
 * Retract a harvested version that should never have been approved: a
 * paywalled landing page, a captcha interstitial, a bare contents page —
 * junk the acquisition ladder imported BEFORE its body-presence gate
 * existed. Retraction is the harvest-case closer the way reconvert is the
 * conversion-case closer: the version book is deleted, the canonical's
 * version pointer is cleared and re-resolved (BookDeletionService →
 * CanonicalVersionSync), and the book's open flags close as `retracted`.
 * The canonical then becomes harvest-eligible again — and the ladder's
 * gates now reject body-absent fetches, so it can only come back as real
 * content.
 *
 * Two guards, honouring "assessment = flag, not verdict":
 *   - Only SYSTEM-ACQUIRED books are retractable, ever. A user's own upload
 *     is theirs to delete through the normal owner flow — no override.
 *   - The stored nodes are re-assessed for body presence; a PRESENT verdict
 *     refuses unless the human explicitly forces (they judged it in the
 *     reader; the machine only gets to make them confirm twice).
 *
 * Used by `php artisan harvest:retract` (bulk, prod cleanup) and the
 * /maintainer/conversion 🗑 retract button (one-off during triage).
 */
class HarvestRetraction
{
    /**
     * conversion_methods produced by the acquisition ladder — the single
     * source for "the system fetched this" (HarvestAuditImportsCommand scopes
     * its audit with the same list). A user's own upload is out of scope.
     */
    public const ACQUIRED_METHODS = [
        'pdf_ocr_auto_raw', 'jats_fulltext', 'paste_engine_html', 'ar5iv_html',
        'html_scrape_unverified', 'web_article_verified', 'web_article_unverified',
    ];

    public const REFUSED_NOT_FOUND    = 'not_found';
    public const REFUSED_NOT_ACQUIRED = 'not_system_acquired';
    public const REFUSED_BODY_PRESENT = 'body_present';

    public function __construct(
        private BodyPresenceAssessor $assessor,
        private BookDeletionService $deleter,
    ) {
    }

    /**
     * Run the guards without deleting anything — the command's --dry-run and
     * the "would this be allowed?" half of retract().
     *
     * @return array{allowed: bool, refusal: ?string, prose_blocks: ?int, prose_chars: ?int, title: ?string}
     */
    public function preflight(string $book, bool $force = false): array
    {
        $out = ['allowed' => false, 'refusal' => null, 'prose_blocks' => null, 'prose_chars' => null, 'title' => null];

        $db = DB::connection('pgsql_admin');
        $row = str_contains($book, '/') ? null : $db->table('library')->where('book', $book)->first();
        if (!$row || $row->visibility === 'deleted') {
            $out['refusal'] = self::REFUSED_NOT_FOUND;
            return $out;
        }
        $out['title'] = $row->title;

        if (!self::isSystemAcquired($row)) {
            $out['refusal'] = self::REFUSED_NOT_ACQUIRED;
            return $out;
        }

        $result = $this->assessor->assessBlocks($this->nodeTexts($book), $this->profileFor($row));
        $out['prose_blocks'] = $result['prose_blocks'];
        $out['prose_chars'] = $result['prose_chars'];
        if ($result['verdict'] === BodyPresenceAssessor::PRESENT && !$force) {
            $out['refusal'] = self::REFUSED_BODY_PRESENT;
            return $out;
        }

        $out['allowed'] = true;
        return $out;
    }

    /**
     * Delete the version book + close its flags. Guards run first; a refusal
     * comes back with allowed=false and nothing touched.
     *
     * @return array{allowed: bool, refusal: ?string, prose_blocks: ?int, prose_chars: ?int, title: ?string,
     *               flags_resolved?: int, delete_stats?: array}
     */
    public function retract(string $book, bool $force = false): array
    {
        $out = $this->preflight($book, $force);
        if (!$out['allowed']) {
            return $out;
        }

        // Admin connection: retraction is a maintainer act on a SYSTEM book —
        // the default connection's RLS context would silently no-op the deletes.
        $out['delete_stats'] = $this->deleter
            ->useConnection(DB::connection('pgsql_admin'))
            ->deleteBook($book);

        $out['flags_resolved'] = ConversionFlag::resolveFor($book, 'retracted', [
            'retracted_prose_blocks' => $out['prose_blocks'],
            'retracted_prose_chars'  => $out['prose_chars'],
        ]);

        return $out;
    }

    /** Book ids with an open flag carrying the audit's body_absent issue type. */
    public function flaggedBooks(): array
    {
        // jsonb_exists(), NOT the `?` operator — PDO reads a literal `?` as a
        // bind placeholder (same footgun HarvestAuditImportsCommand::unflag hit).
        return DB::table('conversion_flags')
            ->where('status', 'open')
            ->whereRaw("jsonb_exists(details->'issueTypes', ?)", ['body_absent'])
            ->orderBy('book')
            ->distinct()
            ->pluck('book')
            ->all();
    }

    /** "The SYSTEM fetched this" — shared with ReconvertQueue's approval promotion. */
    public static function isSystemAcquired(object $row): bool
    {
        return in_array($row->foundation_source ?? null, [
                AutoVersionResolver::FOUNDATION_SOURCE,
                AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
            ], true)
            || in_array($row->conversion_method ?? null, self::ACQUIRED_METHODS, true);
    }

    /** Same profile split as the live gate and the audit. */
    private function profileFor(object $row): string
    {
        return str_starts_with((string) ($row->conversion_method ?? ''), 'web_article')
            ? BodyPresenceAssessor::PROFILE_WEB
            : BodyPresenceAssessor::PROFILE_SCHOLARLY;
    }

    /** @return list<string> the book's node text in reading order */
    private function nodeTexts(string $book): array
    {
        $texts = [];
        DB::connection('pgsql_admin')->table('nodes')->where('book', $book)
            ->orderBy('startLine')
            ->select('plainText', 'content')
            ->chunk(1000, function ($nodes) use (&$texts) {
                foreach ($nodes as $n) {
                    $texts[] = $n->plainText !== null && $n->plainText !== ''
                        ? $n->plainText
                        : strip_tags((string) $n->content);
                }
            });

        return $texts;
    }
}

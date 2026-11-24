<?php

namespace App\Services\Marxists;

use App\Jobs\ProcessDocumentImportJob;
use App\Services\Authors\AuthorKey;
use App\Services\Authors\MarxistsAuthors;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceImport\Content\MarxistsStitcher;
use App\Services\SourceImport\Content\MarxistsWorkFetcher;
use App\Services\SourceImport\Identifier\IdentifierNormalizer;
use App\Services\SourceImport\Identifier\MarxistsId;
use App\Services\SourceImport\Metadata\MarxistsMetadataResolver;
use App\Services\SourceImport\Metadata\MetadataRefused;
use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Support\Licenses;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The maintainer's BULK import of marxists.org (docs/marxists-import.md): list an author's
 * works into the `marxists_works` ledger, then import them a batch at a time.
 *
 * It differs from a person pasting one link (UrlImportController) in three ways, all on purpose:
 *   - the books belong to the SYSTEM account, not to whoever ran the command — nobody
 *     "contributed" them, the credit is marxists.org's;
 *   - they are born unlisted (like the harvested journal corpus): on the archive page, the
 *     author pages and their searches, but not flooding the homepage feeds until reviewed;
 *   - everything rides the `default` queue, behind any import a person is waiting on.
 *
 * Public whatever licence the page states, including none ("Licence unknown"): the text is
 * openly published on marxists.org, every copy links back to its page there, and the user chose
 * that (2026-11-23). HostingPolicy agrees — Unknown is only withheld for saved web EVIDENCE.
 */
class MarxistsBulkImporter
{
    public const STATUS_LISTED = 'listed';
    public const STATUS_QUEUED = 'queued';
    public const STATUS_IMPORTED = 'imported';
    public const STATUS_EXISTS = 'exists';
    public const STATUS_NOT_A_WORK = 'not_a_work';
    public const STATUS_FAILED = 'failed';

    /** Refusals that are a verdict on the PAGE (never retried), as opposed to a hiccup. */
    private const VERDICTS = ['not_a_single_work', 'not_a_text_page', 'no_title', 'too_many_pages', 'not_marxists_org'];

    public function __construct(
        private MarxistsStitcher $stitcher,
        private MarxistsMetadataResolver $resolver,
        private MarxistsWorkFetcher $fetcher,
        private IdentifierNormalizer $normaliser,
        private MarxistsAuthors $authors,
        private HarvestShelf $shelves,
    ) {}

    private static function db()
    {
        return DB::connection('pgsql_admin');
    }

    /**
     * Read an author's listing and record every work it links that the ledger does not hold yet.
     *
     * @return array{ok: bool, error?: string, found?: int, new?: int, already_listed?: int,
     *               by_kind?: array<string, int>, skipped?: array<string, int>, followed?: int,
     *               selected?: array{ok: bool, error?: string, found?: int, marked?: int, unlisted?: list<string>}}
     */
    public function listAuthor(string $author, bool $dryRun = false): array
    {
        $config = MarxistsArchive::AUTHORS[$author] ?? null;
        if ($config === null) {
            return ['ok' => false, 'error' => 'unknown_author'];
        }

        $result = $this->stitcher->listWorks($config['listing']);
        if (! ($result['ok'] ?? false)) {
            return ['ok' => false, 'error' => (string) ($result['error'] ?? 'stitch_failed')];
        }

        $works = $result['works'] ?? [];
        $known = self::db()->table('marxists_works')->whereIn('url', array_column($works, 'url'))->pluck('url')->flip();
        $new = 0;
        $byKind = [];
        foreach ($works as $work) {
            $byKind[$work['kind']] = ($byKind[$work['kind']] ?? 0) + 1;
            if (isset($known[$work['url']])) {
                continue;
            }
            $new++;
            if (! $dryRun) {
                self::db()->table('marxists_works')->insertOrIgnore([
                    'url' => $work['url'],
                    'author' => $author,
                    'listing_url' => $result['listing'] ?? $config['listing'],
                    'link_title' => $work['title'] !== null ? mb_substr($work['title'], 0, 500) : null,
                    'kind' => $work['kind'],
                    'status' => self::STATUS_LISTED,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        }

        $summary = [
            'ok' => true, 'found' => count($works), 'new' => $new, 'already_listed' => count($works) - $new,
            'by_kind' => $byKind, 'skipped' => $result['skipped'] ?? [], 'followed' => count($result['followed'] ?? []),
        ];
        if (isset($config['selected'])) {
            $summary['selected'] = $this->markSelected($author, $config['selected'], array_column($works, 'url'), $dryRun);
        }

        return $summary;
    }

    /**
     * Flag the works the author's Selected Works page links.
     *
     * Only a work the author's OWN listing already found is flagged, matched by address. A
     * Selected Works page also links single chapters and prefaces of longer works (Marx's links
     * "Capital, Chapter One" and the letters index); those are not works of their own, so they
     * are reported back as `unlisted` for a person to look at, never added. A selected page that
     * cannot be read fails only this step: the listing itself is already recorded.
     *
     * @param  list<string>  $listed  every address the author's listing just returned
     * @return array{ok: bool, error?: string, found?: int, marked?: int, unlisted?: list<string>}
     */
    private function markSelected(string $author, string $selectedUrl, array $listed, bool $dryRun): array
    {
        $result = $this->stitcher->listWorks($selectedUrl);
        if (! ($result['ok'] ?? false)) {
            return ['ok' => false, 'error' => (string) ($result['error'] ?? 'stitch_failed')];
        }

        $urls = array_values(array_unique(array_column($result['works'] ?? [], 'url')));
        $inLedger = self::db()->table('marxists_works')->where('author', $author)->whereIn('url', $urls)->pluck('url')->all();
        $matched = array_values(array_intersect($urls, array_merge($listed, $inLedger)));
        if (! $dryRun) {
            // The editors' page names the WORK ("What Is To Be Done? Burning Questions of our
            // Movement"); a by-date listing often links a multi-page work by one of its chapters
            // ("Conclusion", "Preface", "I"), and that link title is what betterTitle() falls
            // back on. So the selected page's wording replaces it.
            $titles = array_column($result['works'] ?? [], 'title', 'url');
            foreach ($matched as $url) {
                $title = trim((string) ($titles[$url] ?? ''));
                self::db()->table('marxists_works')->where('author', $author)->where('url', $url)->update(array_filter([
                    'selected' => true,
                    'link_title' => $title !== '' ? mb_substr($title, 0, 500) : null,
                    'updated_at' => now(),
                ], fn ($v) => $v !== null));
            }
        }

        return ['ok' => true, 'found' => count($urls), 'marked' => count($matched), 'unlisted' => array_values(array_diff($urls, $matched))];
    }

    /**
     * Import ONE ledger row: read the work's page, crawl and stitch it, mint the system-owned
     * book, link its author, shelve it, and queue the conversion. Every outcome is written back
     * to the ledger, so nothing is asked of the site twice.
     *
     * Order matters: the EPUB is stitched BEFORE the library row exists, so a crawl that fails
     * leaves no empty public book behind.
     *
     * @return string the row's new status
     */
    public function importWork(int $workId): string
    {
        $work = self::db()->table('marxists_works')->where('id', $workId)->first();
        if (! $work || $work->status !== self::STATUS_QUEUED) {
            return $work->status ?? 'missing';
        }

        $id = $this->normaliser->parse($work->url);
        if (! $id instanceof MarxistsId) {
            return $this->settle($work, self::STATUS_NOT_A_WORK, 'not a marxists.org text address');
        }

        // Already here (a person imported it, or an earlier run did): one book per contents page.
        $existing = self::db()->table('library')->where('url', $id->url())->where('visibility', '!=', 'deleted')->value('book');
        if ($existing) {
            return $this->settle($work, self::STATUS_EXISTS, null, (string) $existing);
        }

        try {
            $metadata = $this->resolver->resolve($id);
        } catch (MetadataRefused $refused) {
            return $this->settle($work, self::STATUS_NOT_A_WORK, $refused->errorCode);
        }
        if (! $metadata) {
            return $this->settle($work, self::STATUS_FAILED, 'page unavailable');
        }

        $config = MarxistsArchive::AUTHORS[$work->author] ?? ['default_credit' => null];
        $credit = $metadata->data['author_credit'] ?? null ?: $config['default_credit'];
        $authorString = $metadata->author() ?: $config['default_credit'];

        $title = self::betterTitle((string) $metadata->title(), $work->link_title);
        $book = $this->freeBookId($authorString, $metadata->year(), $title);
        $dir = resource_path("markdown/{$book}");
        File::ensureDirectoryExists($dir, 0755);

        $fetch = $this->fetcher->fetch($id, new SourceMetadata([], 'marxists'), $dir);
        if (! $fetch->ok) {
            File::deleteDirectory($dir);
            $verdict = in_array($fetch->reason, self::VERDICTS, true);

            return $this->settle($work, $verdict ? self::STATUS_NOT_A_WORK : self::STATUS_FAILED, (string) $fetch->reason);
        }

        $now = now();
        self::db()->table('library')->insert([
            'book' => $book,
            'title' => $title,
            'author' => $authorString,
            'year' => $metadata->year(),
            'type' => 'book',
            'publisher' => MarxistsMetadataResolver::PUBLISHER,
            'language' => $metadata->data['language'] ?? null,
            'url' => $id->url(),
            'oa_url' => $id->url(),
            'is_oa' => true,
            'note' => $metadata->data['note'] ?? null,
            'work_license' => $metadata->license(),
            // What the work's own page STATES — a code, or "Licence unknown". Never the column
            // default, which is Hyperlit's licence for a user's own writing.
            'license' => Licenses::canonicalCode((string) ($metadata->data['license_code'] ?? '')) ?? Licenses::UNKNOWN,
            'license_url' => $metadata->data['license_url'] ?? null,
            'license_source' => 'source_page',
            'has_nodes' => false,
            'visibility' => 'public',
            'listed' => false,
            'creator' => AutoVersionResolver::CREATOR,
            'creator_token' => null,
            'foundation_source' => 'marxists_org',
            'timestamp' => (int) round(microtime(true) * 1000),
            'raw_json' => json_encode([
                'imported_via' => 'marxists-bulk',
                'identifier_kind' => 'marxists',
                'identifier_value' => $id->value(),
                'scrape_site' => 'marxists.org',
                'listing' => $work->listing_url,
            ]),
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $sameTitle = $this->otherVersionOf($book, $title, $credit);

        try {
            $this->authors->link($book, $credit);
        } catch (\Throwable $e) {
            Log::warning('marxists bulk: author link failed (continuing)', ['book' => $book, 'error' => $e->getMessage()]);
        }
        try {
            $this->shelves->addBooks(MarxistsArchive::ensureShelf(), [$book]);
        } catch (\Throwable $e) {
            Log::warning('marxists bulk: shelf add failed (continuing)', ['book' => $book, 'error' => $e->getMessage()]);
        }

        // Bulk lane: `default`, NEVER the interactive `imports` lane — a person's upload must
        // not wait behind a few thousand of Lenin's letters.
        ProcessDocumentImportJob::dispatch(
            $book,
            $fetch->extension,
            null,
            ['title' => $title, 'author' => $authorString, 'year' => $metadata->year(), 'url' => $id->url()],
            ['creator' => AutoVersionResolver::CREATOR, 'creator_token' => null, 'valid' => true],
        )->onQueue('default');

        return $this->settle($work, self::STATUS_IMPORTED, null, $book, $sameTitle);
    }

    private function settle(object $work, string $status, ?string $reason, ?string $book = null, ?string $sameTitleAs = null): string
    {
        self::db()->table('marxists_works')->where('id', $work->id)->update([
            'status' => $status,
            'reason' => $reason !== null ? mb_substr($reason, 0, 500) : null,
            'book' => $book,
            'same_title_as' => $sameTitleAs,
            'updated_at' => now(),
        ]);

        return $status;
    }

    /**
     * Another book already on this author's page under the same title — a different edition or
     * translation of the same work (the Penguin Capital beside marxists.org's). The marxists.org
     * text is still imported (it IS a different version); this only records the fact, so the
     * maintainer can see which works now have several versions.
     */
    private function otherVersionOf(string $book, string $title, ?string $credit): ?string
    {
        $people = MarxistsAuthors::identify($credit) ?? [];
        if ($people === [] || trim($title) === '') {
            return null;
        }
        $key = self::titleKey($title);

        $candidates = self::db()->table('book_authors as ba')
            ->join('authors as a', 'a.id', '=', 'ba.author_id')
            ->join('library as l', 'l.book', '=', 'ba.book')
            ->whereIn('a.slug', array_column($people, 'slug'))
            ->where('ba.role', 'author')
            ->where('l.book', '!=', $book)
            ->where('l.visibility', '!=', 'deleted')
            ->get(['l.book', 'l.title']);

        foreach ($candidates as $candidate) {
            if (self::titleKey((string) $candidate->title) === $key) {
                return (string) $candidate->book;
            }
        }

        return null;
    }

    /**
     * A short piece is often headed by what it IS — "Afterword", "Letter", "Preface" — and only
     * the author's listing says to what ("Afterword to Letters from Prison to Sophie Liebknecht").
     * When the page's own heading is one or two words and the listing's link says more, the
     * listing's wording is the title. A real short title ("Capital", "Reform or Revolution")
     * usually has no longer link text, and where it does the link names the same work.
     */
    public static function betterTitle(string $pageTitle, ?string $linkTitle): string
    {
        $pageTitle = trim($pageTitle);
        $linkTitle = trim((string) $linkTitle);
        $generic = ['contents', 'index', 'table of contents'];
        if ($linkTitle === '' || in_array(mb_strtolower($linkTitle), $generic, true)) {
            return $pageTitle;
        }
        $words = fn (string $t) => count(preg_split('/\s+/u', $t, -1, PREG_SPLIT_NO_EMPTY) ?: []);

        return $words($pageTitle) <= 2 && $words($linkTitle) > $words($pageTitle) && mb_strlen($linkTitle) <= 250
            ? $linkTitle
            : $pageTitle;
    }

    /** A title without its subtitle or volume: "Capital: A Critique…, Volume One" → "capital". */
    public static function titleKey(string $title): string
    {
        $main = preg_split('/[:;,(\[—–]| - /u', $title, 2)[0] ?? $title;

        return AuthorKey::for($main);
    }

    /** A readable, unused book id: surname-year-first-words-of-the-title. */
    private function freeBookId(?string $author, ?int $year, string $title): string
    {
        $first = trim(explode(';', (string) $author)[0]);
        $surname = Str::slug(Str::afterLast($first, ' ')) ?: 'work';
        $words = implode('-', array_slice(array_filter(explode('-', Str::slug($title))), 0, 5));
        $base = substr(trim(implode('-', array_filter([$surname, $year, $words])), '-'), 0, 90) ?: 'marxists-work';

        for ($i = 1; $i < 200; $i++) {
            $candidate = $i === 1 ? $base : "{$base}-{$i}";
            if (! self::db()->table('library')->where('book', $candidate)->exists()
                && ! File::exists(resource_path("markdown/{$candidate}"))) {
                return $candidate;
            }
        }

        return $base . '-' . Str::lower(Str::random(6));
    }
}

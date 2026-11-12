<?php

namespace App\Services\Licensing;

use App\Services\BookCache;
use App\Services\ShelfCacheInvalidator;
use App\Support\Licenses;
use Illuminate\Support\Facades\DB;

/**
 * Whether Hyperlit may PUBLISH (serve publicly) the text of a work it holds but did not write.
 *
 * Holding a copy is fine — citation review reads WebFetch pages and closed papers on pgsql_admin
 * to check claims against them. Republishing it is not: before this, 2,046 news pages and every
 * closed paper `citation:vacuum` fetched were public, full text, to anonymous readers.
 *
 * The rule: a third-party hosted copy is public only if its licence lets us redistribute it.
 * All rights reserved never; a WebFetch page whose licence is unknown never (a web page is
 * copyrighted by default). Everything else — CC*, PD, CC0, open-unspecified, publisher-open,
 * custom terms, and Unknown on a harvested work still awaiting `library:discover-licenses` —
 * stays as it is. `arXiv-Nonexclusive` is NOT decided here (whether we may host ar5iv copies is
 * an open product question).
 *
 * Scope: system-minted rows and URL imports only. A user's OWN upload — even one verified as
 * someone else's published work — is the owner's call: it goes on their review shelf
 * (LicenceReviewShelf), never silently hidden. And this only ever UNpublishes: making a work
 * public again is a human act — except undoing this policy's OWN hide (held_reason = licence)
 * once the licence turns out to allow it.
 */
final class HostingPolicy
{
    public const WEB_CREATOR = 'WebFetch';

    /** library.held_reason: THIS policy hid the row (so only this policy may un-hide it). */
    public const HELD_LICENCE = 'licence';

    public static function mayPublish(object $row): bool
    {
        $code = Licenses::canonicalCode($row->license ?? null) ?? Licenses::UNKNOWN;
        if ($code === 'All-Rights-Reserved') {
            return false;
        }
        if (self::isWebEvidence($row) && in_array($code, [Licenses::UNKNOWN, Licenses::DEFAULT_USER], true)) {
            return false;
        }

        return true;
    }

    public static function isWebEvidence(object $row): bool
    {
        return ($row->creator ?? null) === self::WEB_CREATOR || ($row->type ?? null) === 'web_source';
    }

    /** Rows this policy governs: third-party works Hyperlit holds, minus a user's own uploads. */
    public static function governed($q, string $alias = 'l'): void
    {
        $q->where(fn ($w) => LicenseDiscovery::thirdPartyWorks($w, $alias))
            ->where(fn ($w) => $w->whereNull("{$alias}.canonical_match_method")->orWhere("{$alias}.canonical_match_method", '!=', 'user_verified'))
            ->whereIn("{$alias}.creator", LicenseDiscovery::SYSTEM_CREATORS);
    }

    /**
     * Unpublish one governed row if the policy says so. Returns true when it changed anything.
     * Safe to call from any write path: a no-op for user books, private rows and open licences.
     */
    public static function enforce(string $book): bool
    {
        $db = DB::connection('pgsql_admin');
        $row = $db->table('library as l')->where('l.book', $book)
            ->where(fn ($q) => self::governed($q))
            ->where('l.visibility', 'public')
            ->first(['l.book', 'l.license', 'l.creator', 'l.type']);
        if (! $row) {
            return self::republishIfAllowed($book);
        }
        if (self::mayPublish($row)) {
            return false;
        }

        self::unpublish($book, self::isWebEvidence($row) && ($row->license ?? null) === Licenses::DEFAULT_USER);

        return true;
    }

    /**
     * A governed row just received text (`ContentFetchService` fill paths — `citation:vacuum`
     * gave DOI'd stubs closed papers' text with no OA check and never wrote a licence back).
     * Stamp the licence of the copy we actually got, the same way AutoVersionCreator does
     * (WorkLicenseResolver::forCanonical / resolve over won_license → work licence → journal),
     * then enforce. A user-chosen licence is never touched.
     *
     * @param  array{won_license?: ?string}  $trace
     */
    public static function settleFetchedCopy(string $book, array $trace): void
    {
        $db = DB::connection('pgsql_admin');
        $row = $db->table('library as l')->where('l.book', $book)
            ->where(fn ($q) => self::governed($q))
            ->first(['l.book', 'l.license', 'l.license_source', 'l.work_license', 'l.oa_status', 'l.canonical_source_id']);
        if (! $row) {
            return;
        }
        if ($row->license_source !== LicenseDiscovery::SOURCE_USER) {
            $won = is_string($trace['won_license'] ?? null) ? $trace['won_license'] : null;
            $canonical = $row->canonical_source_id ? \App\Models\CanonicalSource::on('pgsql_admin')->find($row->canonical_source_id) : null;
            $new = $canonical
                ? WorkLicenseResolver::forCanonical($canonical, $won)
                : WorkLicenseResolver::resolve([$won, $row->work_license], $row->oa_status);
            $hasEvidence = $won || $canonical || trim((string) $row->work_license) !== '' || trim((string) $row->oa_status) !== '';
            if ($hasEvidence && $new['license'] !== $row->license) {
                $db->table('library')->where('book', $book)->update([
                    'license' => $new['license'],
                    'custom_license_text' => $new['custom_license_text'] ?? null,
                    'license_url' => $new['license_url'] ?? null,
                    'license_source' => $won ? 'fetch_trace' : LicenseDiscovery::SOURCE_REMAP,
                    'updated_at' => now(),
                ]);
            }
        }
        self::enforce($book);
    }

    /**
     * Undo our OWN hide when better evidence arrives (discovery finds a CC licence for a
     * repository copy we had hidden as all-rights-reserved). Only rows this policy hid
     * (held_reason = licence) — never a row a person or another process made private.
     */
    public static function republishIfAllowed(string $book): bool
    {
        $row = DB::connection('pgsql_admin')->table('library')->where('book', $book)
            ->where('visibility', 'private')->where('held_reason', self::HELD_LICENCE)
            ->first(['book', 'license', 'creator', 'type']);
        if (! $row || self::isWebEvidence($row) || ! self::mayPublish($row)) {
            return false;
        }
        DB::connection('pgsql_admin')->table('library')->where('book', $book)->update([
            'visibility' => 'public', 'held_reason' => null,
            'timestamp' => (int) round(microtime(true) * 1000), 'updated_at' => now(),
        ]);
        try {
            app(BookCache::class)->invalidate($book);
        } catch (\Throwable) {
        }

        return true;
    }

    /** Make a row private and drop every rendered copy of it. */
    public static function unpublish(string $book, bool $clearDefaultLicence = false): void
    {
        $update = [
            'visibility' => 'private',
            'held_reason' => self::HELD_LICENCE,
            'timestamp' => (int) round(microtime(true) * 1000),
            'updated_at' => now(),
        ];
        if ($clearDefaultLicence) {
            $update['license'] = Licenses::UNKNOWN;
        }
        DB::connection('pgsql_admin')->table('library')->where('book', $book)->update($update);

        try {
            app(BookCache::class)->invalidate($book);
        } catch (\Throwable) {
        }
        try {
            app(ShelfCacheInvalidator::class)->flushShelvesContaining($book);
        } catch (\Throwable) {
        }
    }
}

<?php

namespace App\Services\Licensing;

use App\Services\Licensing\Sources\CrossrefSource;
use App\Services\Licensing\Sources\DataCiteSource;
use App\Services\Licensing\Sources\RowIds;
use App\Services\Security\UrlGuard;
use App\Services\SourceHarvest\OaLicenseMapper;
use App\Services\SourceImport\Content\OaLocationResolver;
use App\Support\Licenses;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * Is a cited work we do NOT hold really open — or does an aggregator merely say so?
 *
 * OpenAlex's `is_oa` is an aggregator's claim, and it is wrong in two recurring ways: a
 * repository RECORD is taken for an open FILE (a HAL deposit whose document is restricted —
 * and was a French translation, filed as a "submitted version" of a 1984 article), and ONE
 * free file is taken for the whole work (JSTOR's free title page of a Pluto Press book,
 * reported as a bronze-open book). A third: the copy is a DIFFERENT WORK — every index
 * attached one French book introduction to an unrelated article's DOI. Offering those for
 * import is the bug this exists for.
 *
 * Same rule LicenseDiscovery applies to licences (its AUTHORITY table): an aggregator's word
 * is a lead, not a finding. A work is CONFIRMED open only by something that is not an
 * aggregator:
 *   - the publisher's own registry deposit states an open licence for the version of record
 *     (Crossref `license[]` / DataCite `rightsList` — the existing LicenseSources);
 *   - it is an arXiv work (arXiv is the host, not a third party describing one);
 *   - its journal is in our diamond registry with one recognised DOAJ licence.
 * Anything else is UNCONFIRMED — shown as the claim it is, never as a fact. The probe of the
 * repository copies only sharpens WHY: "a file downloads but nothing says it is this work"
 * versus "nothing answered at all". It can never confirm, because it cannot see identity.
 *
 * stored() never calls out (it runs for every row of a list); check() does, on a press, and
 * caches its verdict.
 */
class OpenAccessVerifier
{
    public const CONFIRMED = 'confirmed';

    public const UNCONFIRMED = 'unconfirmed';

    /** Nothing but the aggregator's claim, and nobody has asked anyone else yet. */
    public const UNCHECKED = 'unchecked';

    private const MAX_PROBES = 3;

    public function __construct(private OaLocationResolver $locations) {}

    /**
     * The verdict available WITHOUT a network call.
     *
     * @param  object  $canonical  canonical_source row (+ optional `journal_license`: its journal's DOAJ licence)
     * @return array{state: string, basis: ?string}
     */
    public function stored(object $canonical): array
    {
        if ($cached = Cache::get(self::cacheKey($canonical->id))) {
            return $cached;
        }
        if (RowIds::arxivId($canonical) !== null) {
            return ['state' => self::CONFIRMED, 'basis' => 'an arXiv work — arXiv hosts it'];
        }
        $journal = WorkLicenseResolver::usableJournalLicense($canonical->journal_license ?? null);
        if ($journal !== null) {
            return ['state' => self::CONFIRMED, 'basis' => 'its journal is in the diamond open-access registry'];
        }

        return ['state' => self::UNCHECKED, 'basis' => null];
    }

    /**
     * Ask. Publisher registry first (cheap, authoritative), then open the repository copies.
     *
     * @return array{state: string, basis: ?string}
     */
    public function check(object $canonical): array
    {
        // Already settled in its favour: nothing to ask. An earlier "unconfirmed" IS re-asked —
        // a press on check means "look again".
        $verdict = $this->stored($canonical);
        if ($verdict['state'] === self::CONFIRMED) {
            return $verdict;
        }

        $verdict = $this->fromRegistries($canonical)
            ?? $this->fromProbe($canonical)
            ?? ['state' => self::UNCONFIRMED, 'basis' => 'only an index lists it as open: the publisher has deposited no open licence, and no repository copy answered with the file'];

        Cache::put(self::cacheKey($canonical->id), $verdict, now()->addDays($verdict['state'] === self::CONFIRMED ? 30 : 7));

        return $verdict;
    }

    /** Crossref / DataCite: the publisher's deposit names an open licence for the published version. */
    private function fromRegistries(object $canonical): ?array
    {
        $row = (object) ['doi' => $canonical->doi ?? null, 'book' => null, 'has_nodes' => false];
        if (RowIds::doi($row) === null) {
            return null;
        }
        foreach ([new CrossrefSource(), new DataCiteSource()] as $source) {
            try {
                $finding = $source->applies($row) ? $source->lookup($row) : null;
            } catch (\Throwable) {
                $finding = null;
            }
            $code = $finding && $finding->raw !== null ? (OaLicenseMapper::parse($finding->raw)['license'] ?? null) : null;
            if ($code !== null && in_array($code, Licenses::openAccessCodes(), true) && $code !== 'Open-Unspecified') {
                return [
                    'state' => self::CONFIRMED,
                    'basis' => 'the publisher deposited an open licence with ' . ucfirst($source->name()) . ': ' . Licenses::info($code)['label'],
                ];
            }
        }

        return null;
    }

    /**
     * Open the repository copies and see whether a PDF actually comes back. Only repository
     * hosts and only direct-PDF copies: a publisher PDF proves nothing about the WORK (the
     * free title page), and a landing page answers 200 whether or not the file is restricted.
     */
    private function fromProbe(object $canonical): ?array
    {
        $copies = $this->locations->resolve((object) [
            'canonical_source_id' => $canonical->id,
            'doi'                 => $canonical->doi ?? null,
            'openalex_id'         => $canonical->openalex_id ?? null,
            'pdf_url'             => $canonical->pdf_url ?? null,
            'oa_url'              => $canonical->oa_url ?? null,
        ]);

        $versions = $this->versionsByUrl($canonical->id);

        $probed = 0;
        foreach ($copies as $copy) {
            if ($copy['host_class'] !== 'repository' || $copy['kind'] !== 'pdf') {
                continue;
            }
            // A "submitted version" is a different text from the published work — a preprint
            // at best, and in the case that prompted this a French TRANSLATION of a 1984
            // article filed that way. It downloads fine and still is not the cited work.
            if (($copy['version'] ?? $versions[$copy['url']] ?? null) === 'submittedVersion') {
                continue;
            }
            if ($probed++ >= self::MAX_PROBES) {
                break;
            }
            if ($this->servesPdf($copy['url'])) {
                // A file comes back — but that is all a probe can say. The indexes share data,
                // and all of them attached a French book introduction to a Feminist Review
                // DOI: it downloads perfectly and is not the work. Only the import's own
                // identity gate (AutoVersionCreator) can tell, so this stays UNCONFIRMED.
                return [
                    'state' => self::UNCONFIRMED,
                    'basis' => "a file downloads from {$copy['host']}, but nothing confirms it is this work — the publisher has deposited no open licence. Importing checks the text itself",
                ];
            }
        }

        return null;
    }

    /**
     * pdf url => version, from the resolver's persisted gather. Needed because its dedupe
     * keeps the FIRST sighting of a URL — the canonical's own bare pdf_url — and so drops the
     * version the index attached to the same copy.
     *
     * @return array<string, string>
     */
    private function versionsByUrl(string $canonicalId): array
    {
        $stored = \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('canonical_source')
            ->where('id', $canonicalId)->value('oa_locations');
        $stored = is_string($stored) ? json_decode($stored, true) : $stored;
        $out = [];
        foreach ((array) ($stored['locations'] ?? []) as $loc) {
            if (! empty($loc['pdf_url']) && ! empty($loc['version'])) {
                $out[$loc['pdf_url']] = $loc['version'];
            }
        }

        return $out;
    }

    private function servesPdf(string $url): bool
    {
        if (! UrlGuard::isSafeFetchUrl($url)) {
            return false;
        }
        try {
            $r = Http::withHeaders([
                'User-Agent' => 'Hyperlit/1.0 (open-access check; mailto:sam@hyperlit.io)',
                'Range'      => 'bytes=0-2047',
                'Accept'     => 'application/pdf,*/*;q=0.5',
            ])->timeout(12)->connectTimeout(6)->get($url);
        } catch (\Throwable) {
            return false;
        }

        return $r->successful() && str_starts_with(ltrim(substr((string) $r->body(), 0, 1024)), '%PDF');
    }

    public static function cacheKey(string $canonicalId): string
    {
        return 'oa-verify:' . $canonicalId;
    }
}

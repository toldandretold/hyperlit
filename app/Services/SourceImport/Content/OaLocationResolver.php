<?php

namespace App\Services\SourceImport\Content;

use App\Services\OpenAlexService;
use App\Services\SemanticScholarService;
use App\Services\UnpaywallService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Assembles a RANKED, deduped list of open-access download candidates for a
 * work, from every free source (OpenAlex locations[], Unpaywall, Semantic
 * Scholar, Crossref, plus the library row's own oa_url/pdf_url).
 *
 * The ranking is the point: try the copy LEAST likely to be Cloudflare-walled
 * first — a green/repository PDF (arXiv, PMC, Zenodo, an institutional DSpace)
 * before a publisher PDF (direct.mit.edu, tandfonline, …). Most "cloudflare_block"
 * failures on legitimately-open works vanish because a clean repository copy
 * exists and we simply never tried it before.
 *
 * @phpstan-type Candidate array{url: string, kind: 'pdf'|'landing', host: string, host_class: string, source: string}
 */
class OaLocationResolver
{
    public function __construct(
        private OpenAlexService $openAlex,
        private UnpaywallService $unpaywall,
        private SemanticScholarService $semanticScholar,
    ) {
    }

    /** Repository / known-clean hosts — rarely Cloudflare-walled. Matched as substrings of the host. */
    private const REPOSITORY_HOSTS = [
        'arxiv.org', 'ncbi.nlm.nih.gov', 'europepmc.org', 'ebi.ac.uk', 'zenodo.org',
        'openreview.net', 'core.ac.uk', 'biorxiv.org', 'medrxiv.org', 'osf.io',
        'hal.science', 'hal.archives-ouvertes.fr', 'ssoar.info', 'dspace', 'eprints',
        'repository', 'repositorio', 'hdl.handle.net', 'semanticscholar.org',
        'researchgate', 'figshare.com', 'preprints.org', 'dial.uclouvain.be',
        'escholarship.org', 'digitalcommons', 'scholarworks', 'diva-portal.org',
        '.edu', '.ac.uk',
    ];

    /** Publisher hosts that commonly wall PDFs behind Cloudflare / bot checks. */
    private const PUBLISHER_HOSTS = [
        'direct.mit.edu', 'tandfonline.com', 'sciencedirect.com', 'link.springer.com',
        'onlinelibrary.wiley.com', 'journals.sagepub.com', 'academic.oup.com',
        'journals.uchicago.edu', 'cambridge.org', 'jstor.org', 'nature.com',
        'science.org', 'pubs.acs.org', 'ieeexplore.ieee.org', 'dl.acm.org',
        'journals.plos.org', 'emerald.com', 'degruyter.com',
    ];

    /**
     * @param bool $forceRefresh Bypass the persisted cache and re-pull from the
     *                           free APIs (the only path that re-queries them).
     * @return array<int, array{url: string, kind: string, host: string, host_class: string, source: string}>
     */
    public function resolve(object $libraryRecord, bool $forceRefresh = false): array
    {
        $canonicalId = $libraryRecord->canonical_source_id ?? null;

        // The library row's own already-known URLs (from the scan / stub). This
        // is per-VERSION, so it is always taken live from the record and merged
        // in fresh — never cached (it's free, and can differ between versions).
        $librarySeed = [
            'pdf_url'          => $libraryRecord->pdf_url ?? null,
            'landing_page_url' => $libraryRecord->oa_url ?? null,
            'host_type'        => null,
            'source'           => 'library',
        ];

        // Cache HIT: the expensive work-level gather was persisted on the canonical
        // last time. Reuse it — ZERO external API calls. (An empty list is a valid
        // hit: we looked and found no extra copies. Only SQL NULL is a miss.) We
        // still re-rank with the current library seed so per-version URLs count.
        if (!$forceRefresh && $canonicalId !== null) {
            $cached = $this->loadCachedLocations($canonicalId);
            if ($cached !== null) {
                return $this->rankAndDedupe(array_merge([$librarySeed], $cached));
            }
        }

        // Cache MISS (or forced): gather every OA copy from the four free APIs and
        // persist the work-level result on the canonical for next time.
        $workLevel = $this->gatherWorkLevelRaw($libraryRecord);

        if ($canonicalId !== null) {
            $this->persistLocations($canonicalId, $workLevel);
        }

        return $this->rankAndDedupe(array_merge([$librarySeed], $workLevel));
    }

    /**
     * The four free-API gather — OpenAlex locations[], Unpaywall, Semantic
     * Scholar, Crossref — WITHOUT the per-version library seed. This is the slow
     * part we cache on the canonical (see resolve()).
     *
     * @return array<int, array{pdf_url?: ?string, landing_page_url?: ?string, host_type?: ?string, source: string}>
     */
    private function gatherWorkLevelRaw(object $libraryRecord): array
    {
        $doi        = $libraryRecord->doi ?? null;
        $openalexId = $libraryRecord->openalex_id ?? null;

        $raw = [];

        // 1. OpenAlex full locations[] — every green + publisher OA copy.
        try {
            $work = $openalexId
                ? $this->openAlex->fetchByOpenAlexId($openalexId)
                : ($doi ? $this->openAlex->fetchByDoi($doi) : null);
            foreach ($work['oa_locations'] ?? [] as $loc) {
                $raw[] = $loc + ['source' => 'openalex'];
            }
        } catch (\Throwable $e) {
            Log::warning('OaLocationResolver: OpenAlex locations lookup failed', ['error' => $e->getMessage()]);
        }

        // 2. Unpaywall — the richest green-OA index.
        if ($doi) {
            foreach ($this->unpaywall->oaLocations($doi) as $loc) {
                $raw[] = $loc + ['source' => 'unpaywall'];
            }
        }

        // 3. Semantic Scholar — repository copies (PMC etc.) the others miss.
        if ($doi) {
            $s2 = $this->semanticScholar->openAccessPdfByDoi($doi);
            if ($s2) {
                $raw[] = ['pdf_url' => $s2, 'landing_page_url' => null, 'host_type' => null, 'source' => 'semantic_scholar'];
            }
        }

        // 4. Crossref-deposited full-text links (publisher TDM / syndication).
        if ($doi) {
            foreach ($this->crossrefPdfLinks($doi) as $url) {
                $raw[] = ['pdf_url' => $url, 'landing_page_url' => null, 'host_type' => null, 'source' => 'crossref'];
            }
        }

        return $raw;
    }

    /**
     * The persisted work-level candidate list for a canonical, or null when the
     * canonical was never resolved (SQL NULL / no row). An empty array is a
     * deliberate HIT ("resolved, no extra copies") — not a miss.
     *
     * @return array<int, array<string, mixed>>|null
     */
    private function loadCachedLocations(string $canonicalId): ?array
    {
        $stored = DB::connection('pgsql_admin')
            ->table('canonical_source')
            ->where('id', $canonicalId)
            ->value('oa_locations');

        if ($stored === null) {
            return null; // never resolved (or no such row) → cache miss
        }
        if (is_array($stored)) {
            return $stored; // some drivers pre-decode jsonb
        }

        $decoded = json_decode((string) $stored, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Persist the work-level gather on the canonical. Uses pgsql_admin (BYPASSRLS)
     * to mirror the rest of this write path — canonical_source has no RLS, and the
     * queue worker has no HTTP session, so the admin connection is the safe one.
     *
     * @param array<int, array<string, mixed>> $workLevel
     */
    private function persistLocations(string $canonicalId, array $workLevel): void
    {
        DB::connection('pgsql_admin')
            ->table('canonical_source')
            ->where('id', $canonicalId)
            ->update([
                'oa_locations'            => json_encode(array_values($workLevel)),
                'oa_locations_fetched_at' => now(),
                'updated_at'              => now(),
            ]);
    }

    /**
     * Flatten (pdf + landing) → candidates, dedupe by normalised URL, sort so
     * the least-likely-to-be-walled copy comes first.
     *
     * @param array<int, array{pdf_url?: ?string, landing_page_url?: ?string, host_type?: ?string, source: string}> $raw
     * @return array<int, array{url: string, kind: string, host: string, host_class: string, source: string, version: ?string, license: ?string}>
     */
    public function rankAndDedupe(array $raw): array
    {
        $seen = [];
        $candidates = [];

        foreach ($raw as $loc) {
            foreach ([['pdf', $loc['pdf_url'] ?? null], ['landing', $loc['landing_page_url'] ?? null]] as [$kind, $url]) {
                if (!$url) {
                    continue;
                }
                $key = $this->normaliseUrl($url);
                if (isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;

                $host = strtolower((string) parse_url($url, PHP_URL_HOST));
                $candidates[] = [
                    'url'        => $url,
                    'kind'       => $kind,
                    'host'       => $host,
                    'host_class' => $this->classifyHost($host, $loc['host_type'] ?? null),
                    'source'     => $loc['source'],
                    // Carried through for ranking AND so the fetch ladder can record
                    // the license/version of the copy it actually imported.
                    'version'    => $loc['version'] ?? null,
                    'license'    => $loc['license'] ?? null,
                ];
            }
        }

        // Rank: cleaner host first (repository dodges Cloudflare), then a direct
        // PDF before a landing page, then — as tie-breakers WITHIN a host/kind —
        // the more authoritative version and the more open license. Sub-scores are
        // deliberately smaller than the host (100) and kind (10) gaps so they only
        // reorder otherwise-equal copies, never override the anti-Cloudflare order.
        $classScore = ['repository' => 200, 'unknown' => 100, 'publisher' => 0];
        $score = fn (array $c): int =>
            $classScore[$c['host_class']]
            + ($c['kind'] === 'pdf' ? 10 : 0)
            + $this->versionScore($c['version'] ?? null)
            + $this->licenseScore($c['license'] ?? null);
        usort($candidates, fn ($a, $b) => $score($b) <=> $score($a));

        return $candidates;
    }

    /** publishedVersion (version of record) > accepted > unknown > submitted (preprint). Range 0-6. */
    private function versionScore(?string $version): int
    {
        $v = strtolower((string) $version);
        if (str_contains($v, 'published')) return 6;
        if (str_contains($v, 'accepted')) return 4;
        if ($v === '') return 2;                 // unknown sits between accepted and submitted
        if (str_contains($v, 'submitted')) return 1;
        return 2;
    }

    /** Open CC/public-domain > publisher-specific OA > none. Range 0-3. */
    private function licenseScore(?string $license): int
    {
        $l = strtolower((string) $license);
        if ($l === '') return 0;
        if (str_starts_with($l, 'cc') || str_contains($l, 'public-domain') || $l === 'pd') return 3;
        if (str_contains($l, 'publisher-specific')) return 1;
        return 1; // other-oa / unknown-but-present
    }

    private function classifyHost(string $host, ?string $openAlexHostType): string
    {
        if ($host === '') {
            return 'unknown';
        }
        // OpenAlex/Unpaywall's own host_type is authoritative when it says repository.
        if ($openAlexHostType === 'repository') {
            return 'repository';
        }
        // Explicit publisher hosts FIRST — some sit on .edu (direct.mit.edu),
        // which the broad .edu repository heuristic below would misclassify.
        foreach (self::PUBLISHER_HOSTS as $needle) {
            if (str_contains($host, $needle)) {
                return 'publisher';
            }
        }
        foreach (self::REPOSITORY_HOSTS as $needle) {
            if (str_contains($host, $needle)) {
                return 'repository';
            }
        }
        // OpenAlex 'journal'/'publisher' host_type → publisher; else unknown.
        return in_array($openAlexHostType, ['publisher', 'journal'], true) ? 'publisher' : 'unknown';
    }

    /** Normalise for dedupe: lowercase host, drop scheme/query/fragment/trailing slash. */
    private function normaliseUrl(string $url): string
    {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $path = rtrim((string) parse_url($url, PHP_URL_PATH), '/');
        return $host . $path;
    }

    /**
     * PDF links the publisher deposited with Crossref (TDM / syndication).
     */
    private function crossrefPdfLinks(string $doi): array
    {
        try {
            $resp = Http::timeout(15)->get('https://api.crossref.org/works/' . rawurlencode($doi));
            if (!$resp->successful()) {
                return [];
            }
            $urls = [];
            foreach ($resp->json('message.link') ?? [] as $link) {
                $url = $link['URL'] ?? null;
                if (!$url) {
                    continue;
                }
                $isPdf = ($link['content-type'] ?? '') === 'application/pdf'
                    || str_ends_with(strtolower(parse_url($url, PHP_URL_PATH) ?? ''), '.pdf');
                if ($isPdf) {
                    $urls[] = $url;
                }
            }
            return array_values(array_unique($urls));
        } catch (\Throwable $e) {
            Log::warning('Crossref link lookup failed', ['doi' => $doi, 'error' => $e->getMessage()]);
            return [];
        }
    }
}

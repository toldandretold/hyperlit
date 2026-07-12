<?php

namespace App\Services\SourceImport\Content;

use App\Services\OpenAlexService;
use App\Services\SemanticScholarService;
use App\Services\UnpaywallService;
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
     * @return array<int, array{url: string, kind: string, host: string, host_class: string, source: string}>
     */
    public function resolve(object $libraryRecord): array
    {
        $doi        = $libraryRecord->doi ?? null;
        $openalexId = $libraryRecord->openalex_id ?? null;

        $raw = [];

        // 0. The library row's own already-known URLs (from the scan / stub).
        $raw[] = ['pdf_url' => $libraryRecord->pdf_url ?? null, 'landing_page_url' => $libraryRecord->oa_url ?? null, 'host_type' => null, 'source' => 'library'];

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

        return $this->rankAndDedupe($raw);
    }

    /**
     * Flatten (pdf + landing) → candidates, dedupe by normalised URL, sort so
     * the least-likely-to-be-walled copy comes first.
     *
     * @param array<int, array{pdf_url?: ?string, landing_page_url?: ?string, host_type?: ?string, source: string}> $raw
     * @return array<int, array{url: string, kind: string, host: string, host_class: string, source: string}>
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
                ];
            }
        }

        // Rank: cleaner host first, then a direct PDF before a landing page.
        $classScore = ['repository' => 200, 'unknown' => 100, 'publisher' => 0];
        usort($candidates, function ($a, $b) use ($classScore) {
            $sa = $classScore[$a['host_class']] + ($a['kind'] === 'pdf' ? 10 : 0);
            $sb = $classScore[$b['host_class']] + ($b['kind'] === 'pdf' ? 10 : 0);
            return $sb <=> $sa;
        });

        return $candidates;
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

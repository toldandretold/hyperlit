<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * CORE (https://core.ac.uk) — the OA aggregator with its OWN PDF cache: it
 * harvests ~15K repositories/journals and re-hosts the files, so a CORE
 * downloadUrl (core.ac.uk/download/{id}.pdf) fetches with zero bot friction
 * even when every publisher copy of the work is Cloudflare-walled. Measured on
 * our own corpus (2026-08): CORE had a live cached PDF for ~half of the works
 * the rest of the ladder failed outright.
 *
 * Key (config services.core.api_key) is free via email registration. Lookup is
 * POST search-by-DOI — their GET search 500s on quoted phrases, and their
 * purpose-built /discover endpoint is broken server-side, so POST is the one
 * reliable call. Auth: Bearer token.
 *
 * Caveat: a downloadUrl can 404 even when the record says fulltextStatus
 * "enabled" (removed/taken-down cache entries). The fetch ladder already
 * treats a failed download as fall-through, so stale links cost one request.
 */
class CoreService
{
    private const SEARCH_URL = 'https://api.core.ac.uk/v3/search/outputs';

    /**
     * Every OA copy CORE knows for a DOI: its own cached PDF first (the copy
     * only CORE has), then the source repository/publisher URLs it harvested
     * from, which dedupe against the other resolvers' candidates.
     *
     * @return array<int, array{pdf_url: ?string, landing_page_url: ?string, host_type: ?string, version: ?string, license: ?string}>
     */
    public function oaLocations(string $doi): array
    {
        $apiKey = config('services.core.api_key');
        if (!$apiKey) {
            return []; // unkeyed requests are rate-limited too hard for a harvest lane
        }

        try {
            $resp = Http::timeout(20)
                ->withToken($apiKey)
                ->post(self::SEARCH_URL, [
                    'q'     => 'doi:"' . str_replace('"', '', $doi) . '"',
                    'limit' => 5, // the same DOI often has several CORE records (one per harvested repository)
                ]);
            if (!$resp->successful()) {
                return [];
            }

            $locations = [];
            foreach ($resp->json('results') ?? [] as $record) {
                if ($cached = $this->sane($record['downloadUrl'] ?? null)) {
                    $locations[] = [
                        'pdf_url'          => $cached,
                        'landing_page_url' => null,
                        'host_type'        => 'repository', // CORE's own cache — core.ac.uk, never walled
                        'version'          => null,
                        'license'          => $record['license'] ?? null,
                    ];
                }
                foreach ($record['sourceFulltextUrls'] ?? [] as $sourceUrl) {
                    if (!($sourceUrl = $this->sane($sourceUrl))) {
                        continue;
                    }
                    $isPdf = str_ends_with(strtolower((string) parse_url($sourceUrl, PHP_URL_PATH)), '.pdf');
                    $locations[] = [
                        'pdf_url'          => $isPdf ? $sourceUrl : null,
                        'landing_page_url' => $isPdf ? null : $sourceUrl,
                        'host_type'        => null, // let the resolver classify the source host
                        'version'          => null,
                        'license'          => $record['license'] ?? null,
                    ];
                }
            }

            return $locations;
        } catch (\Throwable $e) {
            Log::warning('CORE lookup failed', ['doi' => $doi, 'error' => $e->getMessage()]);
            return [];
        }
    }

    private function sane(?string $url): ?string
    {
        return ($url && filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url)) ? $url : null;
    }
}

<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Unpaywall (https://unpaywall.org) — the richest free index of GREEN open
 * access: for a DOI it lists every known OA copy, including author-deposited
 * repository PDFs that OpenAlex's and Semantic Scholar's snapshots miss. Those
 * repository copies are usually NOT behind Cloudflare, so they're the cheapest
 * way past a walled publisher for a legitimately-open-access work.
 *
 * Keyless but the API requires a contact email query param (config
 * services.unpaywall.email). No key, polite rate limits.
 */
class UnpaywallService
{
    private const BASE_URL = 'https://api.unpaywall.org/v2/';

    /**
     * Every OA location Unpaywall knows for a DOI, richest first (it returns
     * best_oa_location first, then all oa_locations).
     *
     * @return array<int, array{pdf_url: ?string, landing_page_url: ?string, host_type: ?string, version: ?string, license: ?string}>
     */
    public function oaLocations(string $doi): array
    {
        $email = config('services.unpaywall.email');
        if (!$email) {
            return []; // no contact email configured → skip (Unpaywall requires it)
        }

        try {
            $resp = Http::timeout(15)->get(self::BASE_URL . rawurlencode($doi), ['email' => $email]);
            if (!$resp->successful()) {
                return [];
            }

            $locations = [];
            foreach ($resp->json('oa_locations') ?? [] as $loc) {
                $pdf     = $this->sane($loc['url_for_pdf'] ?? null);
                $landing = $this->sane($loc['url_for_landing_page'] ?? ($loc['url'] ?? null));
                if (!$pdf && !$landing) {
                    continue;
                }
                $locations[] = [
                    'pdf_url'          => $pdf,
                    'landing_page_url' => $landing,
                    'host_type'        => $loc['host_type'] ?? null, // 'repository' | 'publisher'
                    'version'          => $loc['version'] ?? null,
                    'license'          => $loc['license'] ?? null,
                ];
            }

            return $locations;
        } catch (\Throwable $e) {
            Log::warning('Unpaywall lookup failed', ['doi' => $doi, 'error' => $e->getMessage()]);
            return [];
        }
    }

    private function sane(?string $url): ?string
    {
        return ($url && filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url)) ? $url : null;
    }
}

<?php

namespace App\Services\JournalHarvest;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * DOAJ (Directory of Open Access Journals) lookup layer — the diamond-OA
 * authority. OpenAlex's apc_usd is unusable for diamond determination (null
 * means "unknown", not "free"; only ~126 sources carry apc_usd:0), while DOAJ
 * records an explicit has-APC flag for every one of its ~23k journals.
 *
 * Two paths: a per-ISSN API lookup for single-journal syncs, and the full CSV
 * dump parsed into an ISSN-keyed index for whole-registry syncs (one HTTP
 * request instead of 23k).
 */
class DoajJournalDirectory
{
    public const API_BASE = 'https://doaj.org/api/search/journals/';
    public const CSV_URL = 'https://doaj.org/csv';

    /**
     * Diamond provenance labels stored on journal_sources.diamond_provenance.
     */
    public const PROVENANCE_OPENALEX_APC_0 = 'openalex_apc_0';
    public const PROVENANCE_DOAJ_NO_APC = 'doaj_no_apc';

    /**
     * Look one journal up in the DOAJ API by ISSN. Besides the APC flag it
     * returns the journal-describing metadata the /j page's about copy
     * composes from — keywords, LCC subject terms, license, review process,
     * institution, and DOAJ's ref URLs. Same keys as parseCsvIndex rows, so
     * the sync command is source-agnostic.
     *
     * @return array|null null when DOAJ has no record (or the API failed)
     */
    public function lookupByIssn(string $issn): ?array
    {
        $response = Http::connectTimeout(10)->timeout(20)
            ->get(self::API_BASE . 'issn:' . trim($issn));

        if (!$response->successful()) {
            Log::warning('DOAJ ISSN lookup returned ' . $response->status(), ['issn' => $issn]);
            return null;
        }

        $bibjson = $response->json('results.0.bibjson');
        if (empty($bibjson)) {
            return null;
        }

        return [
            'has_apc'           => $bibjson['apc']['has_apc'] ?? null,
            'has_other_charges' => $bibjson['other_charges']['has_other_charges'] ?? null,
            'publisher'         => $bibjson['publisher']['name'] ?? null,
            'country'           => $bibjson['publisher']['country'] ?? null,
            'languages'         => array_values(array_filter((array) ($bibjson['language'] ?? []))),
            'keywords'          => array_values(array_filter((array) ($bibjson['keywords'] ?? []))),
            'subjects'          => array_values(array_filter(array_map(
                fn ($s) => $s['term'] ?? null,
                (array) ($bibjson['subject'] ?? [])
            ))),
            'license'           => $bibjson['license'][0]['type'] ?? null,
            'review_process'    => implode(', ', (array) ($bibjson['editorial']['review_process'] ?? [])) ?: null,
            'institution'       => $bibjson['institution']['name'] ?? null,
            'ref_urls'          => array_filter([
                'aims_scope'          => $bibjson['ref']['aims_scope'] ?? null,
                'journal'             => $bibjson['ref']['journal'] ?? null,
                'board'               => $bibjson['ref']['board'] ?? null,
                'oa_statement'        => $bibjson['ref']['oa_statement'] ?? null,
                'author_instructions' => $bibjson['ref']['author_instructions'] ?? null,
            ]) ?: null,
        ];
    }

    /**
     * Download the full DOAJ journal CSV dump and index it by ISSN (both print
     * and online columns key the same row). Header-name lookup, never
     * positional — the CSV's column order drifts; a missing required column
     * fails loudly rather than mis-parsing 23k rows.
     *
     * @return array<string, array{has_apc: bool, publisher: ?string, languages: array}>
     */
    public function loadCsvIndex(): array
    {
        $dir = storage_path('app/tmp');
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        $path = $dir . '/doaj_journals.csv';

        // DOAJ 307-redirects /csv to a signed S3 URL; sink streams the ~40MB
        // file to disk instead of buffering it in memory.
        $response = Http::withOptions([
            'allow_redirects' => true,
            'sink'            => $path,
        ])->connectTimeout(15)->timeout(300)->get(self::CSV_URL);

        if (!$response->successful()) {
            throw new \RuntimeException('DOAJ CSV download returned ' . $response->status());
        }

        return $this->parseCsvIndex($path);
    }

    /**
     * Parse an on-disk DOAJ journal CSV into the ISSN-keyed index. Split from
     * loadCsvIndex so tests can feed a fixture file without HTTP.
     */
    public function parseCsvIndex(string $path): array
    {
        $handle = fopen($path, 'r');
        if ($handle === false) {
            throw new \RuntimeException("Cannot open DOAJ CSV at {$path}");
        }

        try {
            $header = fgetcsv($handle);
            if ($header === false) {
                throw new \RuntimeException('DOAJ CSV is empty');
            }

            $col = array_flip($header);
            foreach (['APC', 'Journal ISSN (print version)', 'Journal EISSN (online version)', 'Publisher'] as $required) {
                if (!isset($col[$required])) {
                    throw new \RuntimeException("DOAJ CSV is missing expected column \"{$required}\" — the dump format has drifted");
                }
            }
            // Optional columns (the $langCol pattern): absent columns degrade
            // to nulls/empties rather than failing the whole 23k-row parse —
            // only the APC/ISSN/Publisher columns are load-bearing enough to
            // deserve the loud fail above.
            $langCol       = $col['Languages in which the journal accepts manuscripts'] ?? null;
            $keywordsCol   = $col['Keywords'] ?? null;
            $subjectsCol   = $col['Subjects'] ?? null;
            $licenseCol    = $col['Journal license'] ?? null;
            $reviewCol     = $col['Review process'] ?? null;
            $institutionCol = $col['Other organisation'] ?? null;
            $aimsCol       = $col["URL for journal's aims & scope"] ?? null;
            $boardCol      = $col['URL for the Editorial Board page'] ?? null;
            $journalUrlCol = $col['Journal URL'] ?? null;

            $splitList = fn (?string $raw): array => array_values(array_filter(array_map('trim', explode(',', (string) $raw))));

            $index = [];
            while (($row = fgetcsv($handle)) !== false) {
                $hasApc = strcasecmp(trim($row[$col['APC']] ?? ''), 'Yes') === 0;
                $entry = [
                    'has_apc'   => $hasApc,
                    'publisher' => trim($row[$col['Publisher']] ?? '') ?: null,
                    'languages' => $langCol !== null
                        ? array_values(array_filter(array_map('trim', explode(',', $row[$langCol] ?? ''))))
                        : [],
                    'keywords'       => $keywordsCol !== null ? $splitList($row[$keywordsCol] ?? null) : [],
                    'subjects'       => $subjectsCol !== null ? $splitList($row[$subjectsCol] ?? null) : [],
                    'license'        => $licenseCol !== null ? (trim($row[$licenseCol] ?? '') ?: null) : null,
                    'review_process' => $reviewCol !== null ? (trim($row[$reviewCol] ?? '') ?: null) : null,
                    'institution'    => $institutionCol !== null ? (trim($row[$institutionCol] ?? '') ?: null) : null,
                    'ref_urls'       => array_filter([
                        'aims_scope' => $aimsCol !== null ? (trim($row[$aimsCol] ?? '') ?: null) : null,
                        'journal'    => $journalUrlCol !== null ? (trim($row[$journalUrlCol] ?? '') ?: null) : null,
                        'board'      => $boardCol !== null ? (trim($row[$boardCol] ?? '') ?: null) : null,
                    ]) ?: null,
                ];

                foreach ([$row[$col['Journal ISSN (print version)']] ?? '', $row[$col['Journal EISSN (online version)']] ?? ''] as $issn) {
                    $issn = trim($issn);
                    if ($issn !== '') {
                        $index[$issn] = $entry;
                    }
                }
            }

            return $index;
        } finally {
            fclose($handle);
        }
    }

    /**
     * The single-place diamond rule. OpenAlex says apc_usd 0 → diamond; else
     * DOAJ's explicit flag decides; no DOAJ record → unknown (null), which the
     * sync skips by default (conservative — never claim diamond without
     * evidence).
     *
     * @param array      $openalexSource normalised source (needs apc_usd)
     * @param array|null $doajRow        row from lookupByIssn/loadCsvIndex, or null
     * @return array{0: ?bool, 1: ?string} [is_diamond (null = unknown), provenance]
     */
    public function isDiamond(array $openalexSource, ?array $doajRow): array
    {
        if (($openalexSource['apc_usd'] ?? null) === 0) {
            return [true, self::PROVENANCE_OPENALEX_APC_0];
        }

        if ($doajRow !== null && array_key_exists('has_apc', $doajRow) && $doajRow['has_apc'] !== null) {
            return $doajRow['has_apc']
                ? [false, null]
                : [true, self::PROVENANCE_DOAJ_NO_APC];
        }

        return [null, null];
    }

    /**
     * Every ISSN a normalised OpenAlex source carries (issn_l + issns),
     * deduped — the DOAJ index is keyed by either form.
     *
     * @return array<int, string>
     */
    public function issnsOf(array $normalisedSource): array
    {
        $issns = (array) ($normalisedSource['issns'] ?? []);
        if (!empty($normalisedSource['issn_l'])) {
            $issns[] = $normalisedSource['issn_l'];
        }

        return array_values(array_unique(array_filter(array_map('trim', $issns))));
    }
}

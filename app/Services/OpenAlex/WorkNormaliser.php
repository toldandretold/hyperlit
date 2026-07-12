<?php

namespace App\Services\OpenAlex;

/**
 * Transforms raw OpenAlex work JSON into the shared citation shape used by
 * every downstream consumer (matching, stubs, canonical rows), plus the
 * BibTeX and abstract reconstruction that shape depends on. Pure — no HTTP,
 * no DB.
 */
class WorkNormaliser
{
    /**
     * Reconstruct plain text from an OpenAlex abstract_inverted_index.
     * The index maps each word to an array of positions: {"word": [0, 5], ...}.
     */
    public static function reconstructAbstract(?array $invertedIndex): ?string
    {
        if (empty($invertedIndex)) {
            return null;
        }

        $words = [];
        foreach ($invertedIndex as $word => $positions) {
            foreach ((array) $positions as $pos) {
                $words[(int) $pos] = (string) $word;
            }
        }

        if (empty($words)) {
            return null;
        }

        ksort($words);

        return implode(' ', $words);
    }

    /**
     * Normalise a raw OpenAlex work object into the shared citation shape.
     */
    public function normaliseWork(array $work): array
    {
        $authorships = $work['authorships'] ?? [];
        $authors = array_map(
            fn($a) => $a['author']['display_name'] ?? 'Unknown',
            array_slice($authorships, 0, 3)
        );
        $author = $authors ? implode('; ', $authors) : null;

        // Structured author list incl. ORCID, for canonical_source.authorships.
        // Future: ORCID match against a verified user → flag is_publisher_uploaded automatically.
        $structuredAuthorships = array_map(function ($a) {
            $rawAuthorId = $a['author']['id'] ?? null;
            $authorId = $rawAuthorId ? basename($rawAuthorId) : null;

            $orcid = $a['author']['orcid'] ?? null;
            if ($orcid && str_starts_with($orcid, 'https://orcid.org/')) {
                $orcid = substr($orcid, strlen('https://orcid.org/'));
            }

            return [
                'name'               => $a['author']['display_name'] ?? null,
                'openalex_author_id' => $authorId,
                'orcid'              => $orcid,
                'position'           => $a['author_position'] ?? null,
                'is_corresponding'   => (bool) ($a['is_corresponding'] ?? false),
            ];
        }, $authorships);

        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : null;

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $pdfUrl = $work['primary_location']['pdf_url']
            ?? $work['best_oa_location']['pdf_url']
            ?? null;

        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;

        $sanitiseUrl = fn(?string $url): ?string =>
            ($url && filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url))
                ? $url
                : null;

        // Every OA copy OpenAlex knows about (green/repository AND publisher),
        // for the OA-location resolver's ranked fetch. host_type distinguishes
        // repository (usually not Cloudflare-walled) from publisher copies.
        $oaLocations = [];
        foreach ($work['locations'] ?? [] as $loc) {
            if (!($loc['is_oa'] ?? false)) {
                continue;
            }
            $locPdf     = $sanitiseUrl($loc['pdf_url'] ?? null);
            $locLanding = $sanitiseUrl($loc['landing_page_url'] ?? null);
            if (!$locPdf && !$locLanding) {
                continue;
            }
            $oaLocations[] = [
                'pdf_url'          => $locPdf,
                'landing_page_url' => $locLanding,
                'host_type'        => $loc['source']['type'] ?? ($loc['host_type'] ?? null), // 'repository' | 'journal' | ...
                'version'          => $loc['version'] ?? null,
                'license'          => $loc['license'] ?? null,
            ];
        }

        return [
            'book'           => null,
            'title'          => $work['title'] ?? null,
            'author'         => $author,
            'has_nodes'      => false,
            'year'           => $work['publication_year'] ?? null,
            'journal'        => $work['primary_location']['source']['display_name'] ?? null,
            'publisher'      => $work['primary_location']['source']['host_organization_name'] ?? null,
            'doi'            => $doi,
            'openalex_id'    => $openalexId,
            'source'         => 'openalex',
            'is_oa'          => $work['open_access']['is_oa'] ?? null,
            'oa_status'      => $work['open_access']['oa_status'] ?? null,
            'oa_url'         => $sanitiseUrl($work['open_access']['oa_url'] ?? null),
            'pdf_url'        => $sanitiseUrl($pdfUrl),
            'work_license'   => $work['primary_location']['license'] ?? null,
            'cited_by_count' => $work['cited_by_count'] ?? null,
            'language'       => $work['language'] ?? null,
            'type'           => $work['type'] ?? null,
            'volume'         => $work['biblio']['volume'] ?? null,
            'issue'          => $work['biblio']['issue'] ?? null,
            'pages'          => ($firstPage && $lastPage) ? $firstPage . '–' . $lastPage : null,
            'bibtex'         => $this->generateBibtex($work),
            'abstract'       => self::reconstructAbstract($work['abstract_inverted_index'] ?? null),
            'authorships'    => $structuredAuthorships,
            'oa_locations'   => $oaLocations,
        ];
    }

    /**
     * Generate a BibTeX entry string from a raw OpenAlex work.
     */
    public function generateBibtex(array $work): string
    {
        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : 'unknown';

        $type = match ($work['type'] ?? '') {
            'journal-article' => 'article',
            'book'            => 'book',
            'book-chapter'    => 'incollection',
            'conference'      => 'inproceedings',
            'dissertation'    => 'phdthesis',
            default           => 'misc',
        };

        $authorships = $work['authorships'] ?? [];
        $bibtexAuthors = array_map(function ($a) {
            $name = $a['author']['display_name'] ?? 'Unknown';
            $parts = explode(' ', trim($name));
            if (count($parts) === 1) {
                return $parts[0];
            }
            $last = array_pop($parts);
            $first = implode(' ', $parts);
            return $last . ', ' . $first;
        }, $authorships);

        $authorStr = implode(' and ', $bibtexAuthors) ?: 'Unknown';

        $title  = $work['title'] ?? '';
        $year   = $work['publication_year'] ?? '';
        $journal = $work['primary_location']['source']['display_name'] ?? null;
        $volume  = $work['biblio']['volume'] ?? null;
        $number  = $work['biblio']['issue'] ?? null;
        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;
        $pages = ($firstPage && $lastPage) ? $firstPage . '--' . $lastPage : ($firstPage ?? null);

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $doiUrl = $doi ? 'https://doi.org/' . $doi : null;

        $fields = [
            'author' => $authorStr,
            'title'  => $title,
            'year'   => (string) $year,
        ];

        if ($journal) {
            $fieldKey = in_array($type, ['inproceedings']) ? 'booktitle' : 'journal';
            $fields[$fieldKey] = $journal;
        }
        if ($volume)  $fields['volume'] = $volume;
        if ($number)  $fields['number'] = $number;
        if ($pages)   $fields['pages']  = $pages;
        if ($doi)     $fields['doi']    = $doi;
        if ($doiUrl)  $fields['url']    = $doiUrl;

        $lines = ["@{$type}{{$openalexId},"];
        foreach ($fields as $key => $value) {
            $escaped = str_replace('{', '\\{', str_replace('}', '\\}', (string) $value));
            $lines[] = "  {$key} = {{$escaped}},";
        }
        $lines[] = '}';

        return implode("\n", $lines);
    }
}

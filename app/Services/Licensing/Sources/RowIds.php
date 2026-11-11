<?php

namespace App\Services\Licensing\Sources;

/** Identifier extraction shared by the sources (library columns first, canonical's second). */
final class RowIds
{
    public static function doi(object $row): ?string
    {
        foreach ([$row->doi ?? null, $row->c_doi ?? null] as $d) {
            $d = strtolower(trim((string) $d));
            $d = (string) preg_replace('#^(https?://(dx\.)?doi\.org/|doi:)#', '', $d);
            if (str_starts_with($d, '10.')) {
                return $d;
            }
        }

        return null;
    }

    public static function openalexId(object $row): ?string
    {
        foreach ([$row->openalex_id ?? null, $row->c_openalex_id ?? null] as $id) {
            if (preg_match('/(W\d+)$/i', trim((string) $id), $m)) {
                return strtoupper($m[1]);
            }
        }

        return null;
    }

    public static function openLibraryKey(object $row): ?string
    {
        foreach ([$row->open_library_key ?? null, $row->c_open_library_key ?? null, $row->url ?? null] as $k) {
            if (preg_match('#/(works|books)/(OL\d+[WM])#i', (string) $k, $m)) {
                return '/' . strtolower($m[1]) . '/' . strtoupper($m[2]);
            }
        }

        return null;
    }

    /** arXiv id from the 10.48550/arXiv.* DOI, or an arxiv.org / ar5iv URL. */
    public static function arxivId(object $row): ?string
    {
        $doi = self::doi($row);
        if ($doi && preg_match('#^10\.48550/arxiv\.(.+)$#i', $doi, $m)) {
            return $m[1];
        }
        foreach ([$row->url ?? null, $row->oa_url ?? null, $row->pdf_url ?? null] as $u) {
            if (preg_match('#(?:arxiv\.org|ar5iv(?:\.labs\.arxiv)?\.org)/(?:abs|pdf|html)/([a-z.-]*/?\d{4}\.?\d{3,5}(?:v\d+)?)#i', (string) $u, $m)) {
                return (string) preg_replace('/v\d+$/', '', $m[1]);
            }
        }

        return null;
    }

    /**
     * Which version of the work we HOST (fetch_trace.json `won_version`: publishedVersion /
     * acceptedVersion / submittedVersion), or null when unrecorded.
     */
    public static function hostedVersion(object $row): ?string
    {
        if (! ($row->has_nodes ?? false)) {
            return null;
        }
        $path = resource_path("markdown/{$row->book}/fetch_trace.json");
        if (! is_file($path)) {
            return null;
        }
        $v = (json_decode((string) file_get_contents($path), true) ?: [])['won_version'] ?? null;

        return is_string($v) && $v !== '' ? $v : null;
    }
}

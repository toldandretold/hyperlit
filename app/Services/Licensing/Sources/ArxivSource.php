<?php

namespace App\Services\Licensing\Sources;

/**
 * arXiv's OAI-PMH record (`metadataPrefix=arXiv`) carries the licence the author chose on
 * submission: a CC licence, or arXiv's own non-exclusive distribution licence — which grants
 * arXiv, and only arXiv, the right to distribute (mapped to `arXiv-Nonexclusive`, not "open").
 * arXiv asks for no more than one request every three seconds.
 */
final class ArxivSource implements LicenseSource
{
    private const ENDPOINTS = ['https://oaipmh.arxiv.org/oai', 'https://export.arxiv.org/oai2'];

    public function name(): string
    {
        return 'arxiv';
    }

    public function applies(object $row): bool
    {
        return RowIds::arxivId($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        $id = RowIds::arxivId($row);
        $lastErr = null;
        foreach (self::ENDPOINTS as $endpoint) {
            try {
                $r = PoliteHttp::get($endpoint, [
                    'verb' => 'GetRecord',
                    'identifier' => "oai:arXiv.org:{$id}",
                    'metadataPrefix' => 'arXiv',
                ], 3.0, ['Accept' => 'application/xml']);
            } catch (\Throwable $e) {
                $lastErr = $e->getMessage();
                continue;
            }
            if (PoliteHttp::isInfraFailure($r) || ! $r->successful()) {
                $lastErr = 'HTTP ' . $r->status();
                continue;
            }

            return self::parse($r->body());
        }

        return LicenseFinding::failed($lastErr ?? 'no endpoint answered');
    }

    public static function parse(string $xml): LicenseFinding
    {
        if (str_contains($xml, 'idDoesNotExist')) {
            return LicenseFinding::none('not an arXiv id');
        }
        if (preg_match('#<license>\s*([^<\s]+)\s*</license>#i', $xml, $m)) {
            return LicenseFinding::said(html_entity_decode($m[1]));
        }

        return LicenseFinding::none('record states no licence');
    }
}

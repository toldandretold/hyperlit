<?php

namespace App\Services\SourceImport\Metadata;

use App\Services\SourceImport\Identifier\GutenbergId;
use App\Services\SourceImport\Identifier\Identifier;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Resolves Project Gutenberg book IDs via Gutenberg's own RDF metadata endpoint
 * (https://www.gutenberg.org/ebooks/<id>.rdf — first-party, no API key, one 302).
 *
 * Everything on Gutenberg is public domain (in the US), so the metadata is
 * stamped is_oa so AccessPolicy routes it down the open branch. Year comes from
 * marc906 (the ORIGINAL publication year) — dcterms:issued is the date Gutenberg
 * released the etext and would claim a 19th-century novel was published last week.
 */
class GutenbergMetadataResolver implements MetadataResolver
{
    private const RDF_URL = 'https://www.gutenberg.org/ebooks/%s.rdf';
    private const TIMEOUT_SECONDS = 30;

    public function supports(Identifier $id): bool
    {
        return $id instanceof GutenbergId;
    }

    public function resolve(Identifier $id): ?SourceMetadata
    {
        if (!$id instanceof GutenbergId) {
            return null;
        }

        try {
            $response = Http::timeout(self::TIMEOUT_SECONDS)
                ->withHeaders(['User-Agent' => 'Hyperlit/1.0 (mailto:sam@hyperlit.io)'])
                ->get(sprintf(self::RDF_URL, $id->value()));
        } catch (\Throwable $e) {
            Log::warning('Gutenberg RDF fetch threw', ['gutenberg_id' => $id->value(), 'error' => $e->getMessage()]);
            return null;
        }

        if (!$response->successful()) {
            Log::info('Gutenberg RDF fetch non-2xx', ['gutenberg_id' => $id->value(), 'status' => $response->status()]);
            return null;
        }

        $data = $this->parseRdf($response->body(), $id);
        if (!$data) {
            Log::warning('Gutenberg RDF unparseable', ['gutenberg_id' => $id->value()]);
            return null;
        }

        return new SourceMetadata($data, 'gutenberg');
    }

    /**
     * @return array<string, mixed>|null Normalised work shape (same keys as
     *         OpenAlexService::normaliseWork() where applicable), or null when
     *         the XML doesn't parse or carries no title.
     */
    private function parseRdf(string $xml, GutenbergId $id): ?array
    {
        $prev = libxml_use_internal_errors(true);
        try {
            $doc = simplexml_load_string($xml);
        } finally {
            libxml_use_internal_errors($prev);
        }
        if ($doc === false) {
            return null;
        }

        $doc->registerXPathNamespace('rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#');
        $doc->registerXPathNamespace('dcterms', 'http://purl.org/dc/terms/');
        $doc->registerXPathNamespace('pgterms', 'http://www.gutenberg.org/2009/pgterms/');

        $first = function (string $xpath) use ($doc): ?string {
            $nodes = $doc->xpath($xpath);
            $value = $nodes ? trim((string) $nodes[0]) : '';
            return $value !== '' ? $value : null;
        };

        $title = $first('//pgterms:ebook/dcterms:title');
        if ($title === null) {
            return null;
        }

        $authors = array_filter(array_map(
            fn ($n) => trim((string) $n),
            $doc->xpath('//pgterms:ebook/dcterms:creator//pgterms:name') ?: []
        ));

        // marc906 is the original publication year; fall back to the Gutenberg
        // release date only when the catalogue doesn't record one.
        $year = null;
        if (preg_match('/^\d{4}$/', (string) $first('//pgterms:ebook/pgterms:marc906'))) {
            $year = (int) $first('//pgterms:ebook/pgterms:marc906');
        } elseif (preg_match('/^(\d{4})/', (string) $first('//pgterms:ebook/dcterms:issued'), $m)) {
            $year = (int) $m[1];
        }

        return [
            'title'        => $title,
            'author'       => $authors ? implode('; ', $authors) : null,
            'year'         => $year,
            'type'         => 'book',
            'publisher'    => 'Project Gutenberg',
            'language'     => $first('//pgterms:ebook/dcterms:language//rdf:value'),
            'url'          => $id->url(),
            'oa_url'       => $id->url(),
            'is_oa'        => true,
            'oa_status'    => null,
            'work_license' => $first('//pgterms:ebook/dcterms:rights'),
        ];
    }
}

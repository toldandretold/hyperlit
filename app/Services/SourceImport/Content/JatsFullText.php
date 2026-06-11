<?php

namespace App\Services\SourceImport\Content;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * JATS / NLM full-text fetch + parse — the AUTHORITATIVE content path.
 *
 * Unlike a scraped HTML DOM (where "did we get the whole article?" is a guess),
 * JATS is structured: <body> is the article, <ref-list> is the bibliography,
 * both explicitly labelled by the schema. So completeness is a fact, not an
 * inference — that's the whole reason to prefer it.
 *
 * SCOPE: works only for the PMC open-access subset (Europe PMC fullTextXML).
 * License-restricted papers (isOA:N) are indexed there but 404 on full XML —
 * same OA gating as PDFs. This complements, not replaces, PDF/browser fetch.
 *
 * Two responsibilities, kept separate so the parser is testable without network:
 *   - fetchXmlByDoi(): DOI → PMCID (NCBI idconv) → Europe PMC fullTextXML
 *   - toArticle(): JATS XML → {html, references, refCount}
 */
class JatsFullText
{
    private const IDCONV = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';
    private const EPMC_FULLTEXT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC%s/fullTextXML';
    private const UA = 'hyperlit/1.0 (mailto:toldandretold@gmail.com)';

    /** DOI → JATS XML string, or null when no OA full text is available. */
    public function fetchXmlByDoi(string $doi): ?string
    {
        $pmcid = $this->doiToPmcid($doi);
        if (!$pmcid) {
            return null;
        }

        try {
            $numeric = ltrim($pmcid, 'PMC');
            $resp = Http::withHeaders(['User-Agent' => self::UA])
                ->timeout(25)
                ->get(sprintf(self::EPMC_FULLTEXT, $numeric));

            if (!$resp->successful()) {
                return null;
            }

            $xml = $resp->body();
            return str_contains($xml, '<body>') ? $xml : null;
        } catch (\Throwable $e) {
            Log::warning('JATS full-text fetch failed', ['doi' => $doi, 'pmcid' => $pmcid, 'error' => $e->getMessage()]);
            return null;
        }
    }

    /** DOI → PMCID via the NCBI ID converter, or null. */
    public function doiToPmcid(string $doi): ?string
    {
        try {
            $resp = Http::withHeaders(['User-Agent' => self::UA])
                ->timeout(15)
                ->get(self::IDCONV, [
                    'ids'    => $doi,
                    'format' => 'json',
                    'tool'   => 'hyperlit',
                    'email'  => 'toldandretold@gmail.com',
                ]);

            if (!$resp->successful()) {
                return null;
            }

            $pmcid = $resp->json('records.0.pmcid');
            return is_string($pmcid) && str_starts_with($pmcid, 'PMC') ? $pmcid : null;
        } catch (\Throwable $e) {
            Log::warning('DOI→PMCID conversion failed', ['doi' => $doi, 'error' => $e->getMessage()]);
            return null;
        }
    }

    /**
     * Transform JATS XML into clean article HTML + a structured reference list.
     *
     * @return array{html: string, references: list<array{key: string, text: string}>, refCount: int, title: ?string}
     */
    public function toArticle(string $xml): array
    {
        $prev = libxml_use_internal_errors(true);
        $doc = new \DOMDocument();
        $doc->loadXML($xml, LIBXML_NOCDATA | LIBXML_NONET);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $xpath = new \DOMXPath($doc);

        $title = $this->nodeText($xpath->query('//front//article-title')->item(0));

        $bodyNode = $xpath->query('//body')->item(0);
        $bodyHtml = $bodyNode ? $this->jatsToHtml($bodyNode) : '';

        $references = [];
        foreach ($xpath->query('//ref-list/ref') as $ref) {
            /** @var \DOMElement $ref */
            $text = trim(preg_replace('/\s+/', ' ', $ref->textContent));
            if ($text === '') {
                continue;
            }
            $references[] = [
                'key'  => $ref->getAttribute('id') ?: ('ref' . (count($references) + 1)),
                'text' => $text,
            ];
        }

        $html = $title !== null ? '<h1>' . htmlspecialchars($title) . "</h1>\n" : '';
        $html .= $bodyHtml;

        return [
            'html'       => $html,
            'references' => $references,
            'refCount'   => count($references),
            'title'      => $title,
        ];
    }

    /**
     * Walk JATS body nodes → HTML. Covers the common element set; unknown
     * elements pass through as their children (never dropped silently).
     */
    private function jatsToHtml(\DOMNode $node): string
    {
        $out = '';
        foreach ($node->childNodes as $child) {
            if ($child->nodeType === XML_TEXT_NODE) {
                $out .= htmlspecialchars($child->textContent);
                continue;
            }
            if ($child->nodeType !== XML_ELEMENT_NODE) {
                continue;
            }
            /** @var \DOMElement $child */
            $inner = $this->jatsToHtml($child);
            $out .= match ($child->nodeName) {
                'sec'      => "<section>{$inner}</section>",
                'title'    => "<h2>{$inner}</h2>",
                'p'        => "<p>{$inner}</p>",
                'italic'   => "<em>{$inner}</em>",
                'bold'     => "<strong>{$inner}</strong>",
                'sup'      => "<sup>{$inner}</sup>",
                'sub'      => "<sub>{$inner}</sub>",
                'list'     => "<ul>{$inner}</ul>",
                'list-item' => "<li>{$inner}</li>",
                'xref'     => '<a href="#' . htmlspecialchars($child->getAttribute('rid')) . '">' . $inner . '</a>',
                'ext-link' => '<a href="' . htmlspecialchars($child->getAttribute('xlink:href') ?: $child->getAttribute('href')) . '">' . $inner . '</a>',
                // Drop figures/tables/media wrappers' chrome but keep captions
                'fig', 'table-wrap', 'graphic', 'media' => '',
                default    => $inner, // unknown wrapper → pass children through
            };
        }
        return $out;
    }

    private function nodeText(?\DOMNode $node): ?string
    {
        if (!$node) {
            return null;
        }
        $text = trim(preg_replace('/\s+/', ' ', $node->textContent));
        return $text === '' ? null : $text;
    }
}

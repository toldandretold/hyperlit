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
                'referenceId' => $ref->getAttribute('id') ?: ('ref' . (count($references) + 1)),
                'content'     => $text,
            ];
        }

        // Footnotes: <fn id="..."> anywhere (author notes, table/fig notes).
        // Skip the ones inside <ref-list> (those are reference annotations).
        $footnotes = [];
        foreach ($xpath->query('//fn[not(ancestor::ref-list)]') as $fn) {
            /** @var \DOMElement $fn */
            $id = $fn->getAttribute('id');
            if (!$id) {
                continue;
            }
            // Strip the leading label (<label>1</label>) from the body text.
            $clone = $fn->cloneNode(true);
            foreach (iterator_to_array($clone->getElementsByTagName('label')) as $label) {
                $label->parentNode->removeChild($label);
            }
            $content = trim(preg_replace('/\s+/', ' ', $clone->textContent));
            if ($content !== '') {
                $footnotes[] = ['footnoteId' => $id, 'content' => $content];
            }
        }

        // Build the complete app-native article HTML: title + body (with exact
        // in-text-citation links already applied by jatsToHtml) + reference list
        // as bib-entries so they render under the body.
        $html = $title !== null ? '<h1>' . htmlspecialchars($title) . "</h1>\n" : '';
        $html .= $bodyHtml;
        if ($references) {
            $html .= "\n<h2>References</h2>\n";
            foreach ($references as $ref) {
                $html .= '<p id="' . htmlspecialchars($ref['referenceId']) . '" class="bib-entry">'
                    . htmlspecialchars($ref['content']) . "</p>\n";
            }
        }

        return [
            'html'       => $html,
            'references' => $references,
            'footnotes'  => $footnotes,
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
                // xref to a bibliographic ref → app-native in-text citation
                // (exact link, JATS declares the target). xref to a footnote →
                // app-native footnote marker. Other xref types → plain anchor.
                'xref'     => $this->jatsXref($child, $inner),
                'ext-link' => '<a href="' . htmlspecialchars($child->getAttribute('xlink:href') ?: $child->getAttribute('href')) . '">' . $inner . '</a>',
                // Drop figures/tables/media wrappers' chrome but keep captions
                'fig', 'table-wrap', 'graphic', 'media' => '',
                default    => $inner, // unknown wrapper → pass children through
            };
        }
        return $out;
    }

    /**
     * Render a JATS <xref> as the app-native marker its ref-type implies:
     *   ref-type="bibr" → <a class="in-text-citation" href="#rid">
     *   ref-type="fn"   → <sup fn-count-id ...> footnote marker
     *   else            → plain anchor
     */
    private function jatsXref(\DOMElement $xref, string $inner): string
    {
        $rid = htmlspecialchars($xref->getAttribute('rid'));
        $type = $xref->getAttribute('ref-type');

        if ($type === 'bibr' && $rid !== '') {
            return '<a class="in-text-citation" href="#' . $rid . '">' . $inner . '</a>';
        }
        if ($type === 'fn' && $rid !== '') {
            $label = trim(strip_tags($inner)) ?: '*';
            return '<sup fn-count-id="' . htmlspecialchars($label) . '" id="' . $rid . '" class="footnote-ref">' . htmlspecialchars($label) . '</sup>';
        }
        return $rid !== '' ? '<a href="#' . $rid . '">' . $inner . '</a>' : $inner;
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

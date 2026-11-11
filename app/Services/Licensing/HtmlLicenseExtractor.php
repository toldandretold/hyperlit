<?php

namespace App\Services\Licensing;

use App\Services\SourceHarvest\OaLicenseMapper;

/**
 * Reads the licence a web page DECLARES about itself — and nothing else.
 *
 * Only explicit, machine-readable declarations count:
 *  - <link rel="license" href> / <a rel="license" href>   (the CC-recommended markup; OJS and
 *                                                           most CC-licensed publishers emit it)
 *  - <meta name="dc.rights | dcterms.rights | dcterms.license | dc.rights.license | citation_license">
 *  - JSON-LD `license` on the page's article object (or a top-level / @graph node)
 *
 * A bare creativecommons.org URL in body text is NOT a declaration — a reference list cites
 * other works' licences, an article about licensing quotes them — so prose is never scanned.
 * A declaration that isn't a recognisable licence ("Copyright (c) 2021 the authors") is
 * dropped too: a copyright notice names a holder, not terms.
 */
final class HtmlLicenseExtractor
{
    private const META_NAMES = ['dc.rights', 'dcterms.rights', 'dcterms.license', 'dc.rights.license', 'citation_license', 'dc.license'];

    /** The first recognised declared licence, as stated (URL/text), or null. */
    public static function extract(string $html): ?string
    {
        foreach (self::declarations($html) as $raw) {
            if (OaLicenseMapper::parse($raw) !== null) {
                return $raw;
            }
        }

        return null;
    }

    /** @return list<string> every declaration found, in document order (link/a, meta, JSON-LD) */
    public static function declarations(string $html): array
    {
        if (trim($html) === '') {
            return [];
        }

        $doc = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8"?>' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $xp = new \DOMXPath($doc);

        $out = [];
        $relLicense = "contains(concat(' ', normalize-space(translate(@rel, 'LICENSE', 'license')), ' '), ' license ')";
        foreach ($xp->query("//link[{$relLicense}][@href] | //a[{$relLicense}][@href]") as $el) {
            $out[] = trim($el->getAttribute('href'));
        }

        foreach ($xp->query('//meta[@name or @property][@content]') as $el) {
            $name = strtolower(trim($el->getAttribute('name') ?: $el->getAttribute('property')));
            if (in_array($name, self::META_NAMES, true)) {
                $out[] = trim($el->getAttribute('content'));
            }
        }

        foreach ($xp->query('//script[@type="application/ld+json"]') as $el) {
            $data = json_decode(trim($el->textContent), true);
            if (! is_array($data)) {
                continue;
            }
            $nodes = array_is_list($data) ? $data : [$data];
            foreach ($nodes as $n) {
                if (is_array($n) && isset($n['@graph']) && is_array($n['@graph'])) {
                    $nodes = array_merge($nodes, $n['@graph']);
                }
            }
            foreach ($nodes as $n) {
                if (! is_array($n) || ! isset($n['license'])) {
                    continue;
                }
                $lic = $n['license'];
                foreach (is_array($lic) && array_is_list($lic) ? $lic : [$lic] as $l) {
                    $v = is_array($l) ? ($l['url'] ?? $l['@id'] ?? $l['name'] ?? null) : $l;
                    if (is_string($v) && trim($v) !== '') {
                        $out[] = trim($v);
                    }
                }
            }
        }

        return array_values(array_filter($out, fn ($s) => $s !== ''));
    }
}

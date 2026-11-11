<?php

namespace App\Services\SourceHarvest;

use App\Support\Licenses;

/**
 * Maps a licence string from upstream metadata (OpenAlex / Unpaywall / CORE slugs, Crossref-
 * style Creative Commons URLs, JATS free text, Project Gutenberg's `dcterms:rights`) onto the
 * `library.license` vocabulary in App\Support\Licenses, so a harvested or imported work shows
 * its REAL licence — not the site default (CC-BY-SA-4.0-NO-AI) it would otherwise inherit.
 *
 * Real strings this has to read, all seen in the library table: `cc-by`, `cc-by-nc-nd`,
 * `CC_BY`, `cc by nc`, `https://creativecommons.org/licenses/by-nc-nd/4.0/`,
 * `http://creativecommons.org/licenses/by/4.0/deed.no`, `public-domain`,
 * "Public domain in the USA.", `info:eu-repo/semantics/openAccess`, `© 2023 The Authors`.
 * The previous version only knew bare slugs, so every URL form fell to `custom` with the URL
 * SHOUTED in capitals as its text, flattened every CC version to 4.0, and called public-domain
 * works CC0 (a dedication the author never made).
 *
 * Two entry points:
 *  - parse()            → a vocabulary result, or NULL when the string carries no licence we
 *                         can recognise (so WorkLicenseResolver can try its next candidate).
 *  - toLibraryLicense() → always a result: parse(), else the OA-status decision for an empty
 *                         string, else `custom` carrying the original text (and its URL).
 */
class OaLicenseMapper
{
    /**
     * @return array{license: string, custom_license_text: ?string, license_url: ?string}
     */
    public static function toLibraryLicense(?string $raw, ?string $oaStatus = null): array
    {
        $raw = trim((string) $raw);

        if ($raw === '') {
            return self::fromStatus($oaStatus);
        }

        if ($parsed = self::parse($raw)) {
            return $parsed;
        }

        // Present but unrecognised — surface the original wording (and link it when it IS a
        // link) rather than a wrong code. Original casing: it is someone's text, not a code.
        $isUrl = (bool) preg_match('#^https?://#i', $raw);

        return [
            'license' => Licenses::CUSTOM,
            'custom_license_text' => mb_substr($raw, 0, 500),
            'license_url' => $isUrl ? mb_substr($raw, 0, 1000) : null,
        ];
    }

    /**
     * No licence string at all. Bronze/closed (or unknown status) = free to read at most, all
     * rights reserved; a genuinely open status with no licence recorded = open, unspecified.
     *
     * @return array{license: string, custom_license_text: null, license_url: null}
     */
    public static function fromStatus(?string $oaStatus): array
    {
        $status = strtolower((string) $oaStatus);
        $open = in_array($status, ['gold', 'green', 'hybrid', 'diamond'], true);

        return ['license' => $open ? 'Open-Unspecified' : 'All-Rights-Reserved', 'custom_license_text' => null, 'license_url' => null];
    }

    /**
     * @return array{license: string, custom_license_text: null, license_url: ?string}|null
     */
    public static function parse(?string $raw): ?array
    {
        $raw = trim((string) $raw);
        if ($raw === '') {
            return null;
        }
        $s = strtolower($raw);

        // A stored code already in the vocabulary (any casing).
        if ($code = Licenses::canonicalCode($raw)) {
            if (! in_array($code, [Licenses::CUSTOM, Licenses::UNKNOWN], true)) {
                return self::hit($code);
            }
        }

        // ── Creative Commons URLs ──────────────────────────────────────────────────
        if (str_contains($s, 'creativecommons.org')) {
            if (preg_match('#/publicdomain/zero#', $s)) {
                return self::hit('CC0');
            }
            if (preg_match('#/publicdomain/mark#', $s)) {
                return self::hit('PDM');
            }
            // Spaces inside the path are an extraction artefact ("by nc nd") — fold to dashes.
            $path = preg_replace('#[\s_]+#', '-', $s);
            if (preg_match('#/licenses/([a-z-]+)(?:/(\d(?:\.\d)?))?#', $path, $m)) {
                $terms = self::canonicalTerms($m[1]);
                if ($terms && ($code = Licenses::ccCode($terms, $m[2] ?? null))) {
                    return self::hit($code);
                }
            }

            return null;
        }

        // ── arXiv's own licences (not open: arXiv alone may distribute) ─────────────
        if (preg_match('#arxiv\.org/licenses/(nonexclusive-distrib|assumed-1991-2003)#', $s)) {
            return self::hit(Licenses::ARXIV_NONEXCLUSIVE, $raw);
        }

        // ── Publisher terms URLs (what Crossref `license[]` carries for paywalled VoRs) ─
        // Elsevier's open-archive user licence = free to read under publisher terms; its TDM
        // licence and the other publishers' standard terms are the ordinary copyright terms.
        if (str_contains($s, 'elsevier.com/open-access/userlicense')) {
            return self::hit('Publisher-Open', $raw);
        }
        // Only patterns we are sure of; any other terms URL stays `custom` carrying its link,
        // which is honest — a guessed "all rights reserved" would not be.
        if (preg_match('#elsevier\.com/tdm/userlicense|springer\.com/tdm|springernature\.com/gp/researchers/text-and-data-mining|wiley\.com/termsandconditions|wiley\.com/10\.1002/tdm_license|ieeexplore\.ieee\.org/xplorehelp/downloads/license-information/ieee\.html|cambridge\.org/core/terms|acm\.org/publications/policies/copyright_policy#', $s)) {
            return self::hit('All-Rights-Reserved', $raw);
        }

        // ── Public domain ──────────────────────────────────────────────────────────
        // Gutenberg: "Public domain in the USA." Slugs: pd, pdm, public-domain, publicdomain.
        if (preg_match('/\bpublic[\s_-]?domain\b/', $s) || in_array($s, ['pd', 'pdm', 'public domain mark'], true)) {
            return self::hit('PDM');
        }

        // ── CC0 ────────────────────────────────────────────────────────────────────
        $tok = trim((string) preg_replace('/[\s_\/]+/', '-', $s), '-');
        if (preg_match('/^cc-?(0|zero)(-?v?1(\.0)?)?(-universal)?$/', $tok)) {
            return self::hit('CC0');
        }

        // ── CC slugs, spaced/underscored forms, and spelled-out names ──────────────
        $spelled = strtr($tok, [
            'creative-commons-' => 'cc-',
            'attribution' => 'by',
            'non-commercial' => 'nc',
            'noncommercial' => 'nc',
            'share-alike' => 'sa',
            'sharealike' => 'sa',
            'no-derivatives' => 'nd',
            'noderivatives' => 'nd',
            'noderivs' => 'nd',
            '-international' => '',
            '-license' => '',
            '-licence' => '',
        ]);
        if (preg_match('/^(?:cc-?)?(by(?:-(?:nc|sa|nd))*)(?:-?v?(\d(?:\.\d)?))?$/', $spelled, $m)
            && (str_starts_with($spelled, 'cc') || str_starts_with($spelled, 'by-') || $spelled === 'by')
        ) {
            $terms = self::canonicalTerms($m[1]);
            if ($terms && ($code = Licenses::ccCode($terms, $m[2] ?? null))) {
                return self::hit($code);
            }
        }

        // ── Non-CC open-access labels ──────────────────────────────────────────────
        if (str_contains($s, 'publisher-specific') || str_contains($s, 'publisher specific')) {
            return self::hit('Publisher-Open');
        }
        if (in_array($s, ['other-oa', 'unspecified-oa', 'other', 'implied-oa'], true)
            || preg_match('#info:eu[\s_-]?repo/semantics/openaccess#', $s)
        ) {
            return self::hit('Open-Unspecified');
        }
        if (preg_match('/\ball[\s_-]rights[\s_-]reserved\b/', $s)) {
            return self::hit('All-Rights-Reserved');
        }

        // A bare copyright notice ("© 2023 The Authors") names a holder, not a licence.
        return null;
    }

    /**
     * Order-insensitive CC term set → canonical path ("by-sa-nc" → "by-nc-sa"). Null for an
     * impossible combination (SA and ND together) or no BY.
     */
    private static function canonicalTerms(string $terms): ?string
    {
        $parts = array_filter(explode('-', strtolower($terms)));
        if (! in_array('by', $parts, true)) {
            return null;
        }
        $nc = in_array('nc', $parts, true);
        $sa = in_array('sa', $parts, true);
        $nd = in_array('nd', $parts, true);
        if ($sa && $nd) {
            return null;
        }
        foreach ($parts as $p) {
            if (! in_array($p, ['by', 'nc', 'sa', 'nd'], true)) {
                return null;
            }
        }

        return 'by' . ($nc ? '-nc' : '') . ($sa ? '-sa' : '') . ($nd ? '-nd' : '');
    }

    /**
     * @param  ?string  $termsUrl  kept as `license_url` when the code has no deed of its own
     *                             (publisher terms, arXiv), so the reader can still follow it
     * @return array{license: string, custom_license_text: null, license_url: ?string}
     */
    private static function hit(string $code, ?string $termsUrl = null): array
    {
        $url = ($termsUrl !== null && preg_match('#^https?://#i', trim($termsUrl))) ? mb_substr(trim($termsUrl), 0, 1000) : null;

        return ['license' => $code, 'custom_license_text' => null, 'license_url' => $url];
    }
}

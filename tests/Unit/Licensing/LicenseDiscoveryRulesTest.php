<?php

/**
 * Licence discovery — what each source's answer is taken to MEAN, and how disagreeing answers
 * are decided. Pure functions (no DB, no HTTP); the command end to end is in
 * tests/Feature/Licensing/DiscoverLicensesCommandTest.php.
 */

use App\Services\Licensing\HtmlLicenseExtractor;
use App\Services\Licensing\LicenseDiscovery;
use App\Services\Licensing\Sources\ArxivSource;
use App\Services\Licensing\Sources\CrossrefSource;
use App\Services\Licensing\Sources\DataCiteSource;
use App\Services\Licensing\Sources\InternetArchiveSource;
use App\Services\Licensing\Sources\RowIds;
use App\Services\SourceHarvest\OaLicenseMapper;
use App\Support\Licenses;

function ev(string $source, ?string $raw): array
{
    $code = $raw !== null ? (OaLicenseMapper::parse($raw)['license'] ?? null) : null;

    return ['source' => $source, 'raw' => $raw, 'code' => $code, 'version_stated' => $code !== null && Licenses::statesVersion($code), 'note' => null];
}

// ── vocabulary ───────────────────────────────────────────────────────────────

test('ccCode never assumes a version', function () {
    expect(Licenses::ccCode('by-nc', null))->toBe('CC-BY-NC');
    expect(Licenses::ccCode('by-nc', '3'))->toBe('CC-BY-NC-3.0');
    expect(Licenses::ccCode('by', '9.9'))->toBe('CC-BY');
    expect(Licenses::statesVersion('CC-BY'))->toBeFalse();
    expect(Licenses::statesVersion('CC-BY-4.0'))->toBeTrue();
    expect(Licenses::statesVersion(Licenses::DEFAULT_USER))->toBeTrue();
    expect(Licenses::ccFamily('CC-BY-NC-ND-3.0'))->toBe('CC-BY-NC-ND');
    expect(Licenses::isValid('CC-BY-NC-SA'))->toBeTrue();
    expect(Licenses::info('CC-BY')['label'])->toBe('CC BY (version not stated)');
});

// ── HTML declarations ────────────────────────────────────────────────────────

test('a page\'s rel=license / meta / JSON-LD declaration is read', function () {
    expect(HtmlLicenseExtractor::extract('<div class="license"><a rel="license" href="https://creativecommons.org/licenses/by-nc/4.0/">CC</a></div>'))
        ->toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    expect(HtmlLicenseExtractor::extract('<head><link rel="License" href="http://creativecommons.org/licenses/by/3.0/"></head>'))
        ->toBe('http://creativecommons.org/licenses/by/3.0/');
    expect(HtmlLicenseExtractor::extract('<head><meta name="DC.rights" content="https://creativecommons.org/licenses/by-sa/4.0/"></head>'))
        ->toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    $ld = json_encode(['@context' => 'https://schema.org', '@graph' => [['@type' => 'WebSite'], ['@type' => 'ScholarlyArticle', 'license' => ['@id' => 'https://creativecommons.org/licenses/by-nd/4.0/']]]]);
    expect(HtmlLicenseExtractor::extract("<script type=\"application/ld+json\">{$ld}</script>"))
        ->toBe('https://creativecommons.org/licenses/by-nd/4.0/');
});

test('a CC URL in prose or a reference list is NOT a declaration', function () {
    $html = '<article><p>We reuse a figure from Smith (2019), licensed under '
        . '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.</p>'
        . '<ol class="references"><li>Doe. https://creativecommons.org/licenses/by-sa/3.0/</li></ol></article>';
    expect(HtmlLicenseExtractor::extract($html))->toBeNull();
});

test('a copyright notice declared as dc.rights is dropped, not filed as a licence', function () {
    expect(HtmlLicenseExtractor::extract('<meta name="dc.rights" content="Copyright (c) 2021 the authors">'))->toBeNull();
});

// ── per-source response parsing ──────────────────────────────────────────────

test('Crossref: only an in-force VoR licence counts — never the AAM or TDM licence', function () {
    $now = gmmktime(0, 0, 0, 6, 1, 2026);
    $lic = fn ($url, $cv, $y) => ['URL' => $url, 'content-version' => $cv, 'start' => ['date-parts' => [[$y, 1, 1]]]];

    // Elsevier pattern: VoR is the TDM user licence; the CC BY-NC-ND belongs to the AAM.
    expect(CrossrefSource::pick([
        $lic('https://www.elsevier.com/tdm/userlicense/1.0/', 'tdm', 2020),
        $lic('https://www.elsevier.com/legal/tdmrep-license', 'vor', 2020),
        $lic('http://creativecommons.org/licenses/by-nc-nd/4.0/', 'am', 2021),
    ], $now))->toBe('https://www.elsevier.com/legal/tdmrep-license');

    // An embargo: the CC licence starts in the future, so the current terms stand.
    expect(CrossrefSource::pick([
        $lic('https://publisher.example/terms', 'vor', 2019),
        $lic('https://creativecommons.org/licenses/by/4.0/', 'vor', 2030),
    ], $now))->toBe('https://publisher.example/terms');

    // Once in force, the latest-starting VoR licence wins.
    expect(CrossrefSource::pick([
        $lic('https://publisher.example/terms', 'vor', 2019),
        $lic('https://creativecommons.org/licenses/by/4.0/', 'vor', 2024),
    ], $now))->toBe('https://creativecommons.org/licenses/by/4.0/');

    expect(CrossrefSource::pick([$lic('http://creativecommons.org/licenses/by/4.0/', 'am', 2020)], $now))->toBeNull();
});

test('DataCite prefers a named licence over the generic open-access statement', function () {
    expect(DataCiteSource::pick([
        ['rights' => 'Open Access', 'rightsUri' => 'info:eu-repo/semantics/openAccess'],
        ['rights' => 'Creative Commons Attribution 4.0 International', 'rightsUri' => 'https://creativecommons.org/licenses/by/4.0/legalcode', 'rightsIdentifier' => 'cc-by-4.0'],
    ]))->toBe('https://creativecommons.org/licenses/by/4.0/legalcode');
    expect(DataCiteSource::pick([['rightsUri' => 'info:eu-repo/semantics/openAccess']]))->toBe('info:eu-repo/semantics/openAccess');
    expect(DataCiteSource::pick([]))->toBeNull();
});

test('arXiv: the record\'s licence element, or honest silence', function () {
    $rec = '<OAI-PMH><GetRecord><record><metadata><arXiv><id>1104.3913</id><license>http://arxiv.org/licenses/nonexclusive-distrib/1.0/</license></arXiv></metadata></record></GetRecord></OAI-PMH>';
    expect(ArxivSource::parse($rec)->raw)->toBe('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
    expect(ArxivSource::parse('<OAI-PMH><GetRecord><record><metadata><arXiv><id>x</id></arXiv></metadata></record></GetRecord></OAI-PMH>')->raw)->toBeNull();
    expect(ArxivSource::parse('<OAI-PMH><error code="idDoesNotExist"/></OAI-PMH>')->note)->toBe('not an arXiv id');
});

test('Internet Archive: licenseurl, else its NOT_IN_COPYRIGHT assessment, else nothing', function () {
    expect(InternetArchiveSource::fromMetadata(['licenseurl' => 'http://creativecommons.org/licenses/by-nc-sa/3.0/']))->toBe('http://creativecommons.org/licenses/by-nc-sa/3.0/');
    expect(OaLicenseMapper::parse(InternetArchiveSource::fromMetadata(['possible-copyright-status' => 'NOT_IN_COPYRIGHT']))['license'])->toBe('PDM');
    expect(InternetArchiveSource::fromMetadata(['possible-copyright-status' => 'UNKNOWN']))->toBeNull();
    expect(InternetArchiveSource::fromMetadata([]))->toBeNull();
});

test('identifiers are found in library or canonical columns and in URLs', function () {
    $row = (object) ['book' => 'b', 'doi' => null, 'c_doi' => 'https://doi.org/10.48550/arXiv.2109.09774', 'url' => null];
    expect(RowIds::doi($row))->toBe('10.48550/arxiv.2109.09774');
    expect(RowIds::arxivId($row))->toBe('2109.09774');
    expect(RowIds::arxivId((object) ['url' => 'http://arxiv.org/abs/1104.3913v2']))->toBe('1104.3913');
    expect(RowIds::openLibraryKey((object) ['url' => 'https://openlibrary.org/works/OL10529881W']))->toBe('/works/OL10529881W');
    expect(RowIds::openalexId((object) ['openalex_id' => 'https://openalex.org/W2126853606']))->toBe('W2126853606');
});

// ── deciding between sources ─────────────────────────────────────────────────

test('the publisher\'s deposit outranks an aggregator even when asked later', function () {
    $d = LicenseDiscovery::decide([ev('openalex', 'cc-by-nc'), ev('crossref', 'https://creativecommons.org/licenses/by/4.0/')]);
    expect($d['license'])->toBe('CC-BY-4.0');
    expect($d['source'])->toBe('crossref');
});

test('a version-less family is completed by a later same-family version, never a different family', function () {
    expect(LicenseDiscovery::decide([ev('openalex', 'cc-by'), ev('europepmc', 'https://creativecommons.org/licenses/by/4.0/')])['license'])->toBe('CC-BY-4.0');
    expect(LicenseDiscovery::decide([ev('openalex', 'cc-by'), ev('europepmc', 'https://creativecommons.org/licenses/by-nc/4.0/')])['license'])->toBe('CC-BY');
});

test('public domain asserted only by aggregators is not accepted', function () {
    // The real case: OpenAlex, Unpaywall and S2 all "public-domain" on a 2010s Springer book.
    expect(LicenseDiscovery::decide([ev('oa_locations', 'public-domain'), ev('openalex', 'public-domain'), ev('semantic_scholar', 'public-domain')]))->toBeNull();
    // From Internet Archive or the publisher it stands.
    expect(LicenseDiscovery::decide([ev('internet_archive', 'Public domain (Internet Archive: NOT_IN_COPYRIGHT)')])['license'])->toBe('PDM');
    expect(LicenseDiscovery::decide([ev('crossref', 'https://creativecommons.org/publicdomain/zero/1.0/')])['license'])->toBe('CC0');
});

test('open-unspecified is upgraded by a specific open licence, never by all-rights-reserved', function () {
    expect(LicenseDiscovery::decide([ev('fetch_trace', 'info:eu-repo/semantics/openAccess'), ev('openalex', 'cc-by-sa')])['license'])->toBe('CC-BY-SA');
    expect(LicenseDiscovery::decide([ev('fetch_trace', 'info:eu-repo/semantics/openAccess'), ev('crossref', 'https://www.elsevier.com/tdm/userlicense/1.0/')])['license'])->toBe('Open-Unspecified');
});

test('with nothing recognised, an unknown terms URL becomes a linked custom licence; prose does not', function () {
    $d = LicenseDiscovery::decide([ev('crossref', 'https://example-press.org/terms'), ev('openalex', null)]);
    expect($d['license'])->toBe(Licenses::CUSTOM);
    expect($d['license_url'])->toBe('https://example-press.org/terms');
    expect(LicenseDiscovery::decide([ev('datacite', 'Restricted access'), ev('openalex', null)]))->toBeNull();
    expect(LicenseDiscovery::decide([]))->toBeNull();
});

test('a decision never counts as a change on a row a person chose', function () {
    $row = (object) ['license' => 'Unknown', 'license_url' => null, 'custom_license_text' => null, 'license_source' => 'user'];
    expect(LicenseDiscovery::changes($row, ['license' => 'CC-BY-4.0', 'license_url' => null, 'custom_license_text' => null, 'source' => 'crossref']))->toBeFalse();
});

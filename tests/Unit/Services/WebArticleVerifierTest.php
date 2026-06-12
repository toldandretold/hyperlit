<?php

/**
 * WebArticleVerifier — the deterministic "is this page the cited article?"
 * test for non-academic web sources (news/gov/blogs that have no DOI).
 *
 * Fixtures are REAL captured pages (Playwright fetch): a BBC news article and
 * a Substack post. Both self-declare via JSON-LD schema.org — the publisher's
 * own headline is matched against the citation title (the web analog of
 * JATS/Highwire). A web source can only ever be "URL-content matched", never
 * canonical (no academic identity).
 */

use App\Services\SourceImport\Content\WebArticleVerifier;

function webFixture(string $name): string
{
    return file_get_contents(dirname(__DIR__, 2) . "/Fixtures/web/{$name}.html");
}

test('extracts JSON-LD article headline from a real BBC news page', function () {
    $meta = (new WebArticleVerifier())->extractMeta(webFixture('bbc-news-article'));
    expect($meta['source'])->toBe('json-ld');
    expect($meta['is_article'])->toBeTrue();
    expect($meta['title'])->toContain('Three Indian sailors killed');
});

test('extracts JSON-LD article headline from a real Substack post', function () {
    $meta = (new WebArticleVerifier())->extractMeta(webFixture('substack-post'));
    expect($meta['source'])->toBe('json-ld');
    expect($meta['is_article'])->toBeTrue();
    expect($meta['title'])->toBe('Open Thread 437');
});

test('VERIFIES when the citation title matches the page headline', function () {
    $v = new WebArticleVerifier();

    $bbc = $v->assess(webFixture('bbc-news-article'), 'Settebello: Three Indian sailors killed in US strike on tanker in Gulf');
    expect($bbc['verdict'])->toBe(WebArticleVerifier::VERIFIED);
    expect($bbc['score'])->toBeGreaterThanOrEqual(0.8);

    $sub = $v->assess(webFixture('substack-post'), 'Open Thread 437');
    expect($sub['verdict'])->toBe(WebArticleVerifier::VERIFIED);
});

test('REJECTS when the page is an article but its headline contradicts the citation', function () {
    // Stale URL / redirect to the wrong piece: the page declares an article,
    // but it isn\'t the one we cited.
    $r = (new WebArticleVerifier())->assess(webFixture('bbc-news-article'), 'A totally unrelated paper about quantum penguins');
    expect($r['verdict'])->toBe(WebArticleVerifier::REJECT);
});

test('stays UNVERIFIED when there is no article self-declaration', function () {
    // A bare page with a <title> but no JSON-LD / og:article and a weak match.
    $html = '<html><head><title>Some Section — Listing Page</title></head><body><nav>links</nav></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'The cited article title');
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
    expect($r['is_article'])->toBeFalse();
});

// ── VERIFY on publisher-declared title evidence, even without og:type=article ──
// (real failures from book_1781172598359: OCCRP/ANI/Interpol/PIB all had
//  matching declared titles but no article self-typing)

test('og:title that exactly matches the citation VERIFIES even without og:type=article (OCCRP case)', function () {
    $html = '<html><head>'
        . '<meta property="og:title" content="New Evidence Bolsters Allegations Adani Group Overcharged for Coal">'
        . '</head><body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'New evidence Bolsters Allegations Adani group overcharged for Coal');
    expect($r['verdict'])->toBe(WebArticleVerifier::VERIFIED);
    expect($r['matched_on'])->toBe('opengraph');
});

test('og:title fully contained with comparable length VERIFIES (Interpol case)', function () {
    $html = '<html><head>'
        . '<meta property="og:title" content="Ukraine: INTERPOL General Secretariat statement">'
        . '</head><body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'Ukraine: Interpol General Secretariat statement, 10 March');
    expect($r['verdict'])->toBe(WebArticleVerifier::VERIFIED);
});

test('declared-article page whose headline is contained in the citation VERIFIES (politicalresearch case)', function () {
    $html = '<html><head><script type="application/ld+json">'
        . '{"@type":"NewsArticle","headline":"A Global Trail of Violence"}'
        . '</script></head><body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, "The global VHP's trail of violence");
    expect($r['verdict'])->toBe(WebArticleVerifier::VERIFIED);
});

test('a long bare <title> exact match VERIFIES (PIB gov print page case)', function () {
    $html = '<html><head><title>Text of Prime Minister Shri Narendra Modi’s address to the Indian community at Madison Square Garden, New York</title></head>'
        . '<body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, "Text of Prime Minister Shri Narendra Modi's address to the Indian community at Madison Square Garden, New York");
    expect($r['verdict'])->toBe(WebArticleVerifier::VERIFIED);
    expect($r['matched_on'])->toBe('title');
});

test('a SHORT bare <title> match does NOT verify (coincidence too plausible)', function () {
    $html = '<html><head><title>Infiltrating Australia</title></head><body><p>x</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'Infiltrating Australia');
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
});

test('a genuinely partial headline match stays unverified (Barrons rewording case)', function () {
    $html = '<html><head><script type="application/ld+json">'
        . '{"@type":"NewsArticle","headline":"Canada Warns India Is Using Cyber Tech To Track Separatists Abroad"}'
        . '</script></head><body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'Canada spy agency says India is using cyber tech to track Sikh separatists');
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
});

// ── REJECT must mean CONFIDENT contradiction — junk pages can't be "rejected" ──

test('a block/paywall shell with article metadata is UNVERIFIED, never rejected', function () {
    // Paywalls/consent walls/soft-404s often still emit og:type=article from the
    // site template with a junk title. We never SAW the article — we cannot
    // claim "this is a different article".
    $html = '<html><head>'
        . '<meta property="og:type" content="article">'
        . '<meta property="og:title" content="Access Denied — please subscribe to continue">'
        . '</head><body><p>subscribe</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'Text of Prime Minister Modi address at Madison Square Garden');
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
    expect($r['note'])->toBe('block_page');
});

test('a junk/truncated citation title cannot produce a reject (garbage in ≠ different article)', function () {
    // Real article page, but the stub's citation title is unusable — a low
    // match score says nothing about the page being wrong.
    $r = (new WebArticleVerifier())->assess(webFixture('bbc-news-article'), 'Modi');
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
    expect($r['note'])->toBe('citation_title_junk');
});

test('a stub title padded with site/author junk around the real headline is not rejected (containment guard)', function () {
    // Jaccard collapses when the citation carries extra tokens, but the page
    // headline is fully CONTAINED in it — that is not a contradiction.
    $html = '<html><head>'
        . '<meta property="og:type" content="article">'
        . '<meta property="og:title" content="Climate policy energy transition">'
        . '</head><body><p>body</p></body></html>';
    $cited = 'Climate policy energy transition special report annex volume two chapter five draft revision appendix tables figures';
    $r = (new WebArticleVerifier())->assess($html, $cited);
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
});

test('a partial title match in the uncertain band stays unverified, not rejected', function () {
    // og:article page whose title overlaps the citation moderately (≈0.6) —
    // enough not to be a contradiction, not enough to confidently verify.
    $html = '<html><head>'
        . '<meta property="og:type" content="article">'
        . '<meta property="og:title" content="Climate policy and the energy transition explained">'
        . '</head><body><p>body</p></body></html>';
    $r = (new WebArticleVerifier())->assess($html, 'Climate policy energy transition reforms');
    expect($r['score'])->toBeGreaterThan(0.3);
    expect($r['score'])->toBeLessThan(0.8);
    expect($r['verdict'])->toBe(WebArticleVerifier::UNVERIFIED);
});

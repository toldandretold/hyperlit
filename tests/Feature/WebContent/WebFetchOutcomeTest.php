<?php

/**
 * Every web fetch reports a NAMED outcome.
 *
 * The bug: fetchAndValidateBatch collapsed a missing pool entry, a connection
 * exception, every non-2xx status, a PDF, "too short after extraction" and an
 * LLM rejection into one bare null — and the Wave 6 consumer then recorded
 * nothing at all, so match_diagnostics reported `no_candidates_all_waves` for
 * references that had a perfectly live URL. "This citation is fabricated" and
 * "our resolver was bot-blocked" are opposite conclusions and they looked
 * identical in the data.
 */

use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebFetchService;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    // The browser rung spawns a Node subprocess that Http::fake cannot reach;
    // leaving it on turns these into multi-minute hangs.
    config()->set('services.source_fetch.browser', false);
});

test('a 404 is DEAD, not merely unresolved', function () {
    Http::fake(['*' => Http::response('<html><body>Not found</body></html>', 404)]);

    $result = app(WebFetchService::class)->fetchAndAssess('https://example.com/gone', 'A Cited Work');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_DEAD)
        ->and($result['http_status'])->toBe(404)
        ->and($result['text'])->toBeNull();
});

test('a 403 is BLOCKED — a live source we were refused, never a dead link', function () {
    // The distinction the reviewer needs: a paywalled or bot-walled page says
    // nothing against the citation, whereas a dead link is evidence of rot.
    Http::fake(['*' => Http::response('nope', 403)]);

    $result = app(WebFetchService::class)->fetchAndAssess('https://example.com/walled', 'A Cited Work');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_BLOCKED)
        ->and($result['grade'])->not->toBe(WebTextAcquirer::GRADE_DEAD);
});

test('a 500 is unreachable, not blocked', function () {
    Http::fake(['*' => Http::response('boom', 500)]);

    expect(app(WebFetchService::class)->fetchAndAssess('https://example.com/broken', 'A Cited Work')['grade'])
        ->toBe(WebTextAcquirer::GRADE_UNREACHABLE);
});

test('a page with no article body is metadata_only, not a silent null', function () {
    Http::fake(['*' => Http::response(
        '<html><head><title>Shell</title></head><body><div id="root"></div>'
        . '<div>Menu</div><div>Sign in</div><div>© 2026</div></body></html>',
        200,
        ['Content-Type' => 'text/html'],
    )]);

    $result = app(WebFetchService::class)->fetchAndAssess('https://example.com/shell', 'A Cited Work');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_METADATA_ONLY)
        ->and($result['reason'])->toContain('no article body');
});

test('the batch returns one entry per input key, always', function () {
    // The old signature omitted keys whose chunk threw, so a caller could not
    // distinguish "not attempted" from "attempted and failed".
    // Real, resolvable host: UrlGuard::isSafeFetchUrl does a live
    // gethostbyname(), so an invented *.test hostname is refused as unsafe
    // before Http::fake is ever consulted. Distinguish the cases by PATH.
    Http::fake([
        'example.com/good*' => Http::response(articlePage(), 200, ['Content-Type' => 'text/html']),
        'example.com/gone*' => Http::response('', 404),
        '*' => Http::response('', 403),
    ]);

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'refA' => ['url' => 'https://example.com/good', 'title' => 'Kolhapur riot report'],
        'refB' => ['url' => 'https://example.com/gone', 'title' => 'Missing Work'],
        'refC' => ['url' => 'https://example.com/walled', 'title' => 'Walled Work'],
    ]);

    expect(array_keys($results))->toEqualCanonicalizing(['refA', 'refB', 'refC'])
        ->and($results['refB']['grade'])->toBe(WebTextAcquirer::GRADE_DEAD)
        ->and($results['refC']['grade'])->toBe(WebTextAcquirer::GRADE_BLOCKED);

    foreach ($results as $row) {
        expect($row)->toHaveKeys(['text', 'grade', 'reason', 'channel', 'http_status']);
    }
});

test('a pool exception is a per-key outcome, not a crashed wave', function () {
    // Http::pool hands back the EXCEPTION OBJECT for a failed request, so
    // calling ->successful() on it is a fatal Error. The old code guarded only
    // ConnectionException — a TooManyRedirectsException therefore threw an
    // uncaught Error that abandoned every remaining chunk in the wave.
    Http::fake(function () {
        throw new \GuzzleHttp\Exception\TooManyRedirectsException(
            'Will not follow more than 5 redirects',
            new \GuzzleHttp\Psr7\Request('GET', 'https://example.com/loop'),
        );
    });

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'refA' => ['url' => 'https://example.com/loop', 'title' => 'Redirect Loop'],
    ]);

    expect($results)->toHaveKey('refA')
        ->and($results['refA']['grade'])->toBe(WebTextAcquirer::GRADE_UNREACHABLE)
        ->and($results['refA']['text'])->toBeNull();
});

test('a connection failure is reported, not swallowed', function () {
    Http::fake(function () {
        throw new ConnectionException('cURL error 28: Operation timed out');
    });

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'refA' => ['url' => 'https://example.com/slow', 'title' => 'Slow Work'],
    ]);

    expect($results['refA']['grade'])->toBe(WebTextAcquirer::GRADE_UNREACHABLE)
        ->and($results['refA']['reason'])->not->toBeNull();
});

test('extractUrl decodes entities so an angle-bracketed URL is not mangled', function () {
    // Academic bibliographies write "Available at: <https://…> (accessed …)",
    // which arrives as &lt;…&gt;. The plain-text pattern stops at a literal '>'
    // but swallowed "&gt;" — measured on 57 of chacko's 59 URL-bearing
    // unresolved references.
    $service = app(WebFetchService::class);

    $bib = '<p><a class="bib-entry" id="widmalm2019b"></a>Widmalm S (2019b) Under Modi Govt, a two-pronged '
         . 'attack. <em>Wire</em>. Available at: &lt;https://thewire.in/politics/india-democracy-modi-government&gt; '
         . '(accessed 17 January 2025).</p>';

    expect($service->extractUrl($bib))->toBe('https://thewire.in/politics/india-democracy-modi-government');
});

test('extractUrl keeps a real query string intact while decoding it', function () {
    $service = app(WebFetchService::class);

    $bib = 'Available at: &lt;https://www.youtube.com/watch?v=f-G-MzKbiUw&amp;t=90&gt; (accessed 22 June 2024).';

    expect($service->extractUrl($bib))->toBe('https://www.youtube.com/watch?v=f-G-MzKbiUw&t=90');
});

test('extractUrl puts back underscores that markdown emphasis ate', function () {
    // Real strings from the chacko corpus. A URL with paired underscores
    // (utm_source…utm_medium, or a slug of words) gets parsed as italics during
    // conversion, so the stored href carries <em> tags where the underscores
    // were — and the href pattern then stops at the '<' and returns a truncated
    // path. 12 hrefs across the phase1 runs are affected; two mea.gov.in press
    // releases resolved as "source not found" purely because of it.
    $service = app(WebFetchService::class);

    $mea = 'Available at: <a href="https://www.mea.gov.in/press-releases.htm?dtl/38417/'
         . 'Indias&lt;em&gt;response&lt;/em&gt;to&lt;em&gt;diplomatic&lt;/em&gt;communication'
         . '&lt;em&gt;from&lt;/em&gt;Canada">MEA</a>';

    expect($service->extractUrl($mea))->toBe(
        'https://www.mea.gov.in/press-releases.htm?dtl/38417/Indias_response_to_diplomatic_communication_from_Canada'
    );

    // Note the tags arrive UNBALANCED here (</em> before <em>) because the
    // emphasis pairing straddles the query string. The inverse is per-tag, so
    // it does not care.
    $toi = '<a href="http://timesofindia.indiatimes.com/articleshow/86632777.cms?'
         . 'utm&lt;/em&gt;source=contentofinterest&amp;utm&lt;em&gt;medium=text&amp;'
         . 'utm&lt;/em&gt;campaign=cppst">TOI</a>';

    expect($service->extractUrl($toi))->toBe(
        'http://timesofindia.indiatimes.com/articleshow/86632777.cms?utm_source=contentofinterest&utm_medium=text&utm_campaign=cppst'
    );
});

test('a bibliography entry keeps its own italics', function () {
    // The repair must be scoped to URL runs — an <em>journal title</em> is
    // markup we want, not a mangled underscore.
    $bib = 'Widmalm S (2019) Under Modi Govt. <em>The Wire</em>. Available at: '
         . '&lt;https://thewire.in/politics/india-democracy&gt; (accessed 17 January 2025).';

    expect(app(WebFetchService::class)->extractUrl($bib))
        ->toBe('https://thewire.in/politics/india-democracy');
});

test('a soft 404 is graded dead, not handed over as thin source text', function () {
    // A 200-serving "the page you're looking for can't be found" was graded
    // thin_extract — i.e. a 404 page presented to the reviewer as the cited
    // source. Gated on failing the body profile so a real article may still
    // contain the words.
    // Padded past fetchHtmlPlain's 500-byte floor with the site chrome a real
    // error page carries, while the error prose itself stays SHORTER than one
    // prose block — which is the shape that defeated a body-text-only check.
    $chrome = '<nav>' . str_repeat('<a href="/x">Section</a>', 20) . '</nav>';
    Http::fake(['*' => Http::response(
        '<html><head><title>Page Not Found | Department of Justice</title></head><body>'
        . $chrome
        . '<main><p>We are sorry, the page you’re looking for can’t be found on the '
        . 'Department of Justice website. Check the URL you entered and try again.</p></main>'
        . '<footer>Contact us</footer></body></html>',
        200,
        ['Content-Type' => 'text/html'],
    )]);

    $result = app(WebFetchService::class)->fetchAndAssess('https://example.com/gone-soft', 'Some Indictment');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_DEAD)
        ->and($result['text'])->toBeNull()
        ->and($result['reason'])->toContain('not-found');
});

test('a not-found page is DEAD while a bot wall is BLOCKED', function () {
    // The two must never collapse. AccessWallDetector used to fire on the
    // not-found vocabulary as well, so a rotted citation URL was reported as
    // "blocked by a bot check" — i.e. a live source we were merely refused,
    // which is the opposite conclusion about the citation's health.
    $wall = app(\App\Services\SourceImport\Content\AccessWallDetector::class);

    $notFound = '<html><head><title>Page Not Found</title></head><body><p>Nothing here.</p></body></html>';
    $botWall = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>';

    expect($wall->detect($notFound))->toBeNull('a 404 title is not an interstitial')
        ->and($wall->detect($botWall))->not->toBeNull('a challenge title still is');

    $garbage = app(\App\Services\Conversion\GarbageDetector::class);
    expect($garbage->isNotFoundPhrase('Page Not Found'))->toBeTrue()
        ->and($garbage->isWallPhrase('Page Not Found'))->toBeFalse()
        ->and($garbage->isWallPhrase('Just a moment...'))->toBeTrue()
        ->and($garbage->isNotFoundPhrase('Just a moment...'))->toBeFalse()
        // The combined vocabulary still covers both, because for harvest's
        // garbage detection either one means "not a book".
        ->and($garbage->isBlockPhrase('Page Not Found'))->toBeTrue()
        ->and($garbage->isBlockPhrase('Just a moment...'))->toBeTrue();
});

test('the not-found pattern does not fire on ordinary prose', function () {
    // The first version used a loose `.{0,40}` gap and condemned a real
    // sentence ("…the page turned on land reform and could not be found
    // wanting"), so the connecting words are enumerated instead.
    $garbage = app(\App\Services\Conversion\GarbageDetector::class);

    expect($garbage->isNotFoundPhrase('Critics said the page turned on land reform and could not be found wanting.'))->toBeFalse()
        ->and($garbage->isNotFoundPhrase('Modi said the document was not found to be credible by the committee.'))->toBeFalse()
        // Both apostrophes, since real pages use the curly U+2019.
        ->and($garbage->isNotFoundPhrase('the page you’re looking for can’t be found'))->toBeTrue()
        ->and($garbage->isNotFoundPhrase("the page you're looking for can't be found"))->toBeTrue();
});

/** A minimal page whose body clears the web profile (2 blocks / 1500 chars). */
function articlePage(): string
{
    $para = '<p>' . str_repeat('Kolhapur police registered cases against eleven people following the unrest. ', 12) . '</p>';

    return '<html><head><title>Riot report</title></head><body><nav>Trending</nav>'
        . "<article>{$para}{$para}{$para}</article><aside>Related</aside></body></html>";
}

test('a paywalled page CONFIRMS the source exists, rather than reporting nothing', function () {
    // The best answer available for a hard paywall, and the one the study cares
    // about most: is the reference real? Publishers declare a headline in
    // JSON-LD / og:title even on a subscription interstitial, so identity is
    // answerable without reading a word of the body.
    //
    // Before this, ft.com came back either `blocked` (identity unknown) or —
    // worse — `irrelevant`, because 476 chars of "Save now on essential digital
    // access" extracted as an article and was then correctly rejected by the
    // relevance screen, which READS as "this is not the cited source" when in
    // fact it is exactly the cited source.
    $cited = 'Adani Group pulls out of $440mn wind power projects in Sri Lanka';

    Http::fake(['*' => Http::response(
        '<html><head><title>Subscribe to read</title>'
        . '<meta property="og:title" content="' . $cited . '">'
        . '<script type="application/ld+json">{"@type":"NewsArticle","headline":"' . $cited . '"}</script>'
        . '</head><body><main><p>Save now on essential digital access to trusted journalism. '
        . 'Savings based on annualised monthly rates versus the standard plan.</p></main>'
        . '<nav>' . str_repeat('<a href="/x">Section</a>', 20) . '</nav></body></html>',
        200,
        ['Content-Type' => 'text/html'],
    )]);

    $result = app(WebFetchService::class)->fetchAndAssess('https://example.com/paywalled-piece', $cited);

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_PAYWALLED)
        // No text: the marketing copy is not evidence about any claim.
        ->and($result['text'])->toBeNull()
        ->and($result['reason'])->toContain('matching the citation');
});

test('identity confirmation does not rubber-stamp an unrelated citation', function () {
    // The negative control. If the declared headline does NOT match, we must
    // not claim the source exists — that would turn the check into a machine
    // for confirming any reference pointing at any live URL.
    Http::fake(['*' => Http::response(
        '<html><head><title>Subscribe to read</title>'
        . '<meta property="og:title" content="Adani Group pulls out of wind power projects">'
        . '</head><body><main><p>Save now on essential digital access to trusted journalism. '
        . 'Savings based on annualised monthly rates versus the standard plan.</p></main>'
        . '<nav>' . str_repeat('<a href="/x">Section</a>', 20) . '</nav></body></html>',
        200,
        ['Content-Type' => 'text/html'],
    )]);

    $result = app(WebFetchService::class)->fetchAndAssess(
        'https://example.com/paywalled-piece',
        'A completely unrelated article about beekeeping in Devon',
    );

    expect($result['grade'])->not->toBe(WebTextAcquirer::GRADE_PAYWALLED);
});

test('a paywalled confirmation is never mistaken for readable content', function () {
    // It proves EXISTENCE, not support. The prompt wording has to say so, or a
    // reviewer could read "confirmed" and treat the claim as supported.
    expect(in_array(WebTextAcquirer::GRADE_PAYWALLED, WebTextAcquirer::USABLE_GRADES, true))->toBeFalse();

    $described = WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_PAYWALLED);
    expect($described)->toContain('but not its text')
        ->and($described)->toContain('UNVERIFIED')
        ->and($described)->toContain('absence of support here is no evidence');
});

test('the resolver stores the page it fetched, so the conversion stage need not refetch', function () {
    // The single biggest cost of a citation review once resolution improved:
    // ContentFetchService::importWebSource downloaded every web source AGAIN
    // with a browser to run its identity check and paste-engine conversion.
    // Chacko went from 35 web sources to 94, at roughly a minute each — over
    // half the run spent re-downloading pages already in hand.
    //
    // `fetched_page.html` is the same ground-truth filename that stage writes
    // at the end and that reconvertHtmlLaneFromStoredPage reads, so the
    // resolver is simply filling it in earlier.
    Http::fake(['*' => Http::response(articlePage(), 200, ['Content-Type' => 'text/html'])]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/story');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_ARTICLE_EXTRACT)
        ->and($result['staged_page'] ?? null)->toBeString()
        ->and(is_file($result['staged_page']))->toBeTrue();

    // And creating the stub moves it into the book's directory under the name
    // the conversion stage looks for.
    $db = DB::connection('pgsql_admin');
    $bookId = app(WebFetchService::class)->createWebStubWithNodes(
        $db, 'A story', 'Reporter', 2024, (string) $result['text'],
        'https://example.com/story', $result['grade'], $result['staged_page'],
    );

    try {
        expect(is_file(resource_path("markdown/{$bookId}/fetched_page.html")))->toBeTrue();
    } finally {
        $db->table('nodes')->where('book', $bookId)->delete();
        $db->table('library')->where('book', $bookId)->delete();
        \Illuminate\Support\Facades\File::deleteDirectory(resource_path("markdown/{$bookId}"));
    }
});

test('a grade with no article text stages no page', function () {
    // Nothing to hand on, and writing a wall or a shell to fetched_page.html
    // would poison the conversion stage with a page we already judged useless.
    Http::fake(['*' => Http::response('nope', 403)]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/walled');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_BLOCKED)
        ->and($result['staged_page'] ?? null)->toBeNull();
});

/**
 * Typographic spaces a PUBLISHER inserts inside a URL so a long link can wrap.
 *
 * Found 2026-09-19 while adjudicating nicholls-nieo: one UNCTAD reference arrives as
 * "?ln<U+2009>=<U+2009>en&v<U+2009>=<U+2009>pdf" in the paste/HTML lane and percent-encoded into
 * the href ("?ln%E2%80%89=%E2%80%89en") in the EPUB lane. Either spelling sends characters the
 * server never indexed, and the reference then reports "source not found" for a reason that has
 * nothing to do with the citation.
 *
 * Deleting rather than truncating is safe because a thin/hair/zero-width space is never valid in a
 * URL — its presence is always this artifact. An ORDINARY space still ends a URL.
 */
it('removes a LITERAL thin space the typesetter put inside the URL', function () {
    $svc = app(\App\Services\WebFetchService::class);
    $content = "Prebisch, Raúl. 1964. UNCTAD. https://digitallibrary.un.org/record/696640?ln\u{2009}=\u{2009}en&v\u{2009}=\u{2009}pdf(open in a new window).";

    expect($svc->extractUrl($content))->toBe('https://digitallibrary.un.org/record/696640?ln=en&v=pdf');
});

it('removes a PERCENT-ENCODED thin space from an EPUB href', function () {
    $svc = app(\App\Services\WebFetchService::class);
    $content = '<a href="https://digitallibrary.un.org/record/696640?ln%E2%80%89=%E2%80%89en">UNCTAD</a>';

    expect($svc->extractUrl($content))->toBe('https://digitallibrary.un.org/record/696640?ln=en');
});

it('removes zero-width and word-joiner characters too', function () {
    $svc = app(\App\Services\WebFetchService::class);

    expect($svc->extractUrl("see https://example.com/a\u{200B}b\u{FEFF}c"))
        ->toBe('https://example.com/abc');
});

it('still lets an ORDINARY space end the URL', function () {
    // The distinction the fix rests on: a normal space is a real boundary, and swallowing it would
    // drag the next words of the bibliography entry into the URL.
    $svc = app(\App\Services\WebFetchService::class);

    expect($svc->extractUrl('Available at https://example.com/path then more words here.'))
        ->toBe('https://example.com/path');
});

it('leaves an untouched URL exactly as it was', function () {
    $svc = app(\App\Services\WebFetchService::class);

    expect($svc->extractUrl('See https://example.com/a?b=c&d=e (accessed 2025).'))
        ->toBe('https://example.com/a?b=c&d=e')
        ->and($svc->extractUrl('Available at: <https://doi.org/10.1017/S0892679423000424>.'))
        ->toBe('https://doi.org/10.1017/S0892679423000424');
});

// ---------------------------------------------------------------- escalation keeps findings

function acquirerFailure(string $grade, string $reason, string $channel, ?string $title = null): array
{
    $r = [
        'text' => null, 'grade' => $grade, 'reason' => $reason, 'channel' => $channel,
        'final_url' => 'https://www.youtube.com/watch?v=f-G-MzKbiUw', 'chars' => 0,
        'prose_blocks' => 0, 'format' => null, 'references' => 0,
        'extraction' => 'none', 'http_status' => null,
    ];
    if ($title !== null) {
        $r['title'] = $title;
    }

    return $r;
}

test('a text-less LADDER FINDING beats the pooled pass\'s generic grade', function () {
    // The bug: pass 2's escalated result was kept only when it carried TEXT, so a Hindi
    // video's honest refusal — foreign_language, "the en track is a machine translation" —
    // was thrown away in favour of pass 1's "JS shell, no prose block survived" (chacko
    // modi2024a, an entire study run). The ladder subsumes the pooled GET; its answer wins.
    Http::fake(['*' => Http::response(
        '<html><head><title>YouTube</title></head><body><div id="root"></div></body></html>',
        200, ['Content-Type' => 'text/html'],
    )]);
    $acquirer = Mockery::mock(WebTextAcquirer::class);
    $acquirer->shouldReceive('assessHtml')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_METADATA_ONLY, 'page had no article body', 'plain',
    ));
    $acquirer->shouldReceive('acquire')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_FOREIGN_LANGUAGE,
        "the video is in 'hi', not en. YouTube's en captions for it are a MACHINE TRANSLATION",
        'transcript',
        'Illegal immigrants are snatching the opportunities meant for the Youth of West Bengal: PM Modi',
    ));
    app()->instance(WebTextAcquirer::class, $acquirer);

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'modi2024a' => ['url' => 'https://www.youtube.com/watch?v=f-G-MzKbiUw', 'title' => 'Illegal immigrants…'],
    ]);

    expect($results['modi2024a']['grade'])->toBe(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE)
        ->and($results['modi2024a']['reason'])->toContain('MACHINE TRANSLATION')
        ->and($results['modi2024a']['title'])->toContain('Illegal immigrants');
});

test('a transient unreachable on escalation does NOT overwrite a page pass 1 actually graded', function () {
    Http::fake(['*' => Http::response(
        '<html><head><title>Shell</title></head><body><div id="root"></div></body></html>',
        200, ['Content-Type' => 'text/html'],
    )]);
    $acquirer = Mockery::mock(WebTextAcquirer::class);
    $acquirer->shouldReceive('assessHtml')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_METADATA_ONLY, 'page had no article body', 'plain',
    ));
    $acquirer->shouldReceive('acquire')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_UNREACHABLE, 'connection reset', 'plain',
    ));
    app()->instance(WebTextAcquirer::class, $acquirer);

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'x' => ['url' => 'https://example.com/shell', 'title' => 'A Cited Work'],
    ]);

    expect($results['x']['grade'])->toBe(WebTextAcquirer::GRADE_METADATA_ONLY);
});

test('a source-KIND verdict outranks the pooled pass even when it is a transient throttle', function () {
    // A YouTube URL's pooled GET can only ever say "this HTML has no article in it". When the
    // ladder dispatched by SOURCE KIND (transcript/pdf), its answer is about the SOURCE, so the
    // transient-unreachable exception must not apply — otherwise "page had no article body"
    // outranks "YouTube throttled the caption download" and the misdiagnosis is back.
    Http::fake(['*' => Http::response(
        '<html><head><title>YouTube</title></head><body><div id="root"></div></body></html>',
        200, ['Content-Type' => 'text/html'],
    )]);
    $acquirer = Mockery::mock(WebTextAcquirer::class);
    $acquirer->shouldReceive('assessHtml')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_METADATA_ONLY, 'page had no article body', 'plain',
    ));
    $acquirer->shouldReceive('acquire')->andReturn(acquirerFailure(
        WebTextAcquirer::GRADE_UNREACHABLE,
        'YouTube rate-limited the caption download (HTTP 429) — a temporary throttle',
        'transcript',
    ));
    app()->instance(WebTextAcquirer::class, $acquirer);

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'modi2024a' => ['url' => 'https://www.youtube.com/watch?v=f-G-MzKbiUw', 'title' => 'Illegal immigrants…'],
    ]);

    expect($results['modi2024a']['grade'])->toBe(WebTextAcquirer::GRADE_UNREACHABLE)
        ->and($results['modi2024a']['reason'])->toContain('throttle')
        ->and($results['modi2024a']['channel'])->toBe('transcript');
});

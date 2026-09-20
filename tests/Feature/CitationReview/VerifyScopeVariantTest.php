<?php

use App\Services\LlmService;

/**
 * The two verification prompts whose difference is the study's open methodological question.
 *
 * The support scale had no defined DENOMINATOR: `unlikely` conflated "the source supports none of
 * this" with "the source supports exactly the part it was cited for, but not the rest of the
 * sentence". Those are opposite conclusions about the author. The real case: "This article is part
 * of a Special Issue commemorating the fiftieth anniversary of the campaign for a NIEO (UN 1974a,
 * 1974b)" — the 1974 Declaration is direct evidence the campaign happened and says nothing about a
 * Special Issue published fifty years later.
 *
 * Both variants must exist simultaneously so they can be run against the SAME ground truth, which
 * is labelled as what the citation actually supports and is therefore denominator-independent.
 */
function verifyPrompt(): string
{
    $svc = app(LlmService::class);
    $m = new ReflectionMethod($svc, 'verifyCitationSystemPrompt');
    $m->setAccessible(true);

    return $m->invoke($svc);
}

it('defaults to STRICT, so an unflagged run keeps the historical meaning', function () {
    expect(config('services.citation_review.verify_scope'))->toBe('strict')
        ->and(verifyPrompt())->not->toContain('A SINGLE CITATION MAY ALSO');
});

it('adds the fragment clause ONLY under the fragment variant', function () {
    config(['services.citation_review.verify_scope' => 'fragment']);
    $p = verifyPrompt();

    expect($p)->toContain('A SINGLE CITATION MAY ALSO SUPPORT ONLY PART OF THE SENTENCE')
        // NB: assert on fragments that do not span the prompt's line wraps.
        ->and($p)->toContain('which assertion in this sentence was THIS citation')
        // It must instruct the model to REPORT the split, or the verdict is unauditable.
        ->and($p)->toContain('which part it supports');
});

it('keeps the verdict vocabulary identical across variants', function () {
    // The scale must not drift — only what it is measured against changes. If a variant invented a
    // new verdict value, the two runs would no longer be comparable at all.
    config(['services.citation_review.verify_scope' => 'strict']);
    $strict = verifyPrompt();
    config(['services.citation_review.verify_scope' => 'fragment']);
    $fragment = verifyPrompt();

    $json = '{"support": "confirmed|likely|plausible|unlikely|rejected"';
    expect($strict)->toContain($json)->and($fragment)->toContain($json);

    foreach (['confirmed', 'likely', 'plausible', 'unlikely', 'rejected'] as $v) {
        expect($strict)->toContain("\"{$v}\"")->and($fragment)->toContain("\"{$v}\"");
    }
});

it('differs from strict ONLY by the added clause', function () {
    config(['services.citation_review.verify_scope' => 'strict']);
    $strict = verifyPrompt();
    config(['services.citation_review.verify_scope' => 'fragment']);
    $fragment = verifyPrompt();

    // Everything the historical prompt said must survive verbatim — the four rejection tests, the
    // primary-source guidance, the multi-source burden rule.
    foreach (explode("\n", $strict) as $line) {
        if (trim($line) === '') {
            continue;
        }
        expect($fragment)->toContain($line);
    }
    expect(strlen($fragment))->toBeGreaterThan(strlen($strict));
});

it('an unknown variant falls back to strict rather than silently dropping guidance', function () {
    config(['services.citation_review.verify_scope' => 'typo-variant']);

    expect(verifyPrompt())->not->toContain('A SINGLE CITATION MAY ALSO');
});

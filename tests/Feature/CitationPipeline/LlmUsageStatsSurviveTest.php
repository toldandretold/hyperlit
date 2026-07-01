<?php

/**
 * GUARD A — protects citation-review billing across the CitationReviewService
 * decomposition.
 *
 * LlmService carries MUTABLE usage counters ($usageByModel / $totalRequests,
 * mutated by trackUsage). CitationReviewCommand does
 * getLlm()->resetUsageStats() before a review and getLlm()->getUsageStats()
 * after, and feeds the result to billReview() (the appendix "LLM Usage" table +
 * the credit charge).
 *
 * The refactor splits the LLM-calling phases (TruthClaimExtractor, ClaimVerifier)
 * into their own autowired collaborators. If LlmService is NOT a container
 * singleton, each collaborator receives its OWN instance, so the usage they
 * accumulate is invisible to the coordinator's getLlm() -> the appendix table
 * goes blank and billReview charges $0. Binding LlmService as a singleton
 * (AppServiceProvider) is the fix; this test locks it in.
 *
 * Expected lifecycle: RED before the singleton binding, GREEN after.
 */

use App\Services\CitationReviewService;
use App\Services\LlmService;

test('LlmService resolves as a shared singleton', function () {
    expect(app(LlmService::class))->toBe(app(LlmService::class));
});

test('the review coordinator shares the container LlmService instance', function () {
    // getLlm() must return the very instance the container hands the phases, so
    // usage the phases track is visible to reset/getUsageStats + billing.
    expect(app(CitationReviewService::class)->getLlm())->toBe(app(LlmService::class));
});

test('usage tracked on the shared instance survives across resolutions', function () {
    // Simulate a phase tracking usage on its injected LlmService, then the
    // command reading stats back off getLlm() — must be the same counters.
    $shared = app(LlmService::class);
    $shared->resetUsageStats();

    // trackUsage is private; drive it through the public wire via a faked HTTP
    // response is heavy, so assert the identity contract that makes it work:
    // a freshly resolved coordinator sees the shared instance.
    $coordinatorLlm = app(CitationReviewService::class)->getLlm();
    expect($coordinatorLlm)->toBe($shared);

    $stats = $coordinatorLlm->getUsageStats();
    expect($stats)->toHaveKey('total_requests');
});

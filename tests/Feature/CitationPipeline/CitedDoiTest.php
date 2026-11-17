<?php

/**
 * The printed-DOI derivation is multi-work aware: a footnote's content holds every
 * work's identifiers, so extractDoi(content) returns the FIRST DOI whatever work the
 * pool item represents — which is how deloitte c58's Panko (2008) item took the
 * Csernoch (2024) Entropy DOI, "resolved" by local_doi to the wrong book, and never
 * ran its own ladder (SourceWorkMismatch voided the verdict, but the work was never
 * searched). Stricter than CitedUrl: a mis-attributed DOI is a confidently wrong
 * canonical match, so multi-work items take ONLY their own llm doi — no content
 * fallback.
 */

use App\Services\CitationPipeline\Resolution\CitedDoi;
use App\Services\OpenAlexService;

const CD_CONTENT = 'Panko, Raymond. (2008). Thinking is Bad: Implications of Human Error Research; '
    . 'Csernoch, Maria & Hannusch, Carolin & Piroska, Biro. (2024). Modification of Erroneous '
    . 'and Correct Digital Texts. Entropy. 26. 1015. 10.3390/e26121015.';

function cdOpenAlex(): OpenAlexService
{
    return app(OpenAlexService::class);
}

it('a multi-work parent takes ONLY its own llm doi — the content’s first DOI is another work’s', function () {
    $parent = [
        'content' => CD_CONTENT,
        'llmMetadata' => ['doi' => null, 'sub_citations' => [['title' => 'Modification of Erroneous and Correct Digital Texts', 'doi' => '10.3390/e26121015']]],
    ];
    // Panko prints no DOI of its own: NO identifier, rather than Csernoch's.
    expect(CitedDoi::printed($parent, cdOpenAlex()))->toBeNull();

    $parent['llmMetadata']['doi'] = '10.1016/j.jsis.2008.01.001';
    expect(CitedDoi::printed($parent, cdOpenAlex()))->toBe('10.1016/j.jsis.2008.01.001');
});

it('a sub uses ONLY its own work’s llm doi', function () {
    $sub = [
        'parentRefId' => 'fn64',
        'content' => CD_CONTENT,
        'llmMetadata' => ['doi' => '10.3390/e26121015'],
    ];
    expect(CitedDoi::printed($sub, cdOpenAlex()))->toBe('10.3390/e26121015');

    $sub['llmMetadata'] = [];
    expect(CitedDoi::printed($sub, cdOpenAlex()))->toBeNull();
});

it('a single-work entry keeps the historical order: content regex first, llm fallback', function () {
    $single = [
        'content' => 'Csernoch et al (2024) Modification. Entropy. 10.3390/e26121015.',
        'llmMetadata' => ['doi' => '10.9999/llm-invented'],
    ];
    // The regex reads the printed characters — it outranks the LLM's copy.
    expect(CitedDoi::printed($single, cdOpenAlex()))->toBe('10.3390/e26121015');

    $noPrinted = ['content' => 'Panko (2008) Thinking is Bad.', 'llmMetadata' => ['doi' => '10.1234/x']];
    expect(CitedDoi::printed($noPrinted, cdOpenAlex()))->toBe('10.1234/x');
});

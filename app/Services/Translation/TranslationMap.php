<?php

namespace App\Services\Translation;

/**
 * THE map of a whole-book translation run — same philosophy as
 * SourceHarvest\HarvestMap (itself a sibling of CitationPipeline\PipelineMap):
 * every stage carries a `plain` note (the single source for what it does,
 * shown in the live visualisation) and a `code_ref` + `dev` note so an error
 * in the viz points at the code.
 *
 * Deliberately a SIBLING of those maps, not a merge: each map is drift-tested
 * against its own emitter, and a translation is a different lifecycle.
 *
 * Anti-drift: tests/Feature/Translation/TranslationMapDriftTest.php fails if
 * a stage id here stops matching a `stage: '…'` record literal in
 * BookTranslationService / TranslateBookJob / BookTranslationController, or
 * if a code_ref stops resolving. Add a stage to the run = add it here.
 */
final class TranslationMap
{
    /** @return array<int, string> stage ids in execution order */
    public static function stageIds(): array
    {
        return array_column(self::stages(), 'id');
    }

    /**
     * Stages in execution order. Ids MUST match the stage literals passed to
     * BookTranslationService::record().
     */
    public static function stages(): array
    {
        return [
            [
                'id'       => 'queued',
                'title'    => 'Waiting for a translator',
                'plain'    => 'Your book is in line for the translation worker. One book translates at a time, so if someone else\'s novel is mid-run this can take a while — your place is held and nothing is lost by waiting.',
                'dev'      => 'TranslateBookJob on the dedicated `translation` queue (hyperlit-translation worker, numprocs=1). The start endpoint records `started`; the job records `completed` the moment a worker picks it up.',
                'code_ref' => 'app/Jobs/TranslateBookJob.php',
                'signals'  => [],
            ],
            [
                'id'       => 'text',
                'title'    => 'Translating the text',
                'plain'    => 'The book\'s chapters translate as whole sections, so names, pronouns and context carry across paragraphs. Kimi K3 reasons before it answers, which is why the first results take a minute or two. Every finished paragraph is saved as it lands — an interruption never loses work or costs twice.',
                'dev'      => 'HtmlTranslator::translateFragments pass 1 over the book\'s nodes: sections at h1–h3, ~batch_chars per request as a JSON object with the previous few translations as context, inline elements swapped for placeholders so ids/hrefs never pass through the model. Progress = chars done/total from the batch events.',
                'code_ref' => 'app/Services/Translation/HtmlTranslator.php',
                'signals'  => ['section', 'sections', 'title', 'paragraphs', 'chars_done', 'chars_total', 'retried'],
            ],
            [
                'id'       => 'notes',
                'title'    => 'Translating the footnotes',
                'plain'    => 'The book\'s footnotes and their expanded note pages translate as a second pass, with the same care and the same save-as-it-lands caching. A book with no footnotes skips this.',
                'dev'      => 'translateFragments pass 2 over footnotes.content + the footnote sub-books\' nodes, one fragment map. Recorded `skipped` when the book has neither.',
                'code_ref' => 'app/Services/Translation/BookTranslationService.php',
                'signals'  => ['section', 'sections', 'title', 'paragraphs', 'chars_done', 'chars_total', 'retried'],
            ],
            [
                'id'       => 'write',
                'title'    => 'Writing your copy',
                'plain'    => 'Every translated paragraph is written into a new book in your library — same structure, same footnote links, bibliography kept intact so citations still resolve — and it appears on your page. If the original is public, so is your translation: you paid once, nobody pays again.',
                'dev'      => 'BookTranslationService::writeCopy — one pgsql_admin transaction cloning library/nodes/footnotes/bibliography with node ids preserved and hypercite markers unwrapped, then updateBookOnUserPage. `completed` carries new_book.',
                'code_ref' => 'app/Services/Translation/BookTranslationService.php',
                'signals'  => ['nodes', 'footnotes', 'references', 'new_book'],
            ],
        ];
    }
}

<?php

namespace App\Services\CitationPipeline\Resolution;

/**
 * THE ladder's order — the one place it lives.
 *
 * Two consumers, deliberately fed from the same list so they cannot disagree:
 * `CitationScanBibliographyJob::handle()` RUNS the waves in this order, and
 * `ResolutionLadderMap` DERIVES the published map (stations and edges) from it. Before this
 * existed the map was a hand-declared copy of what the job did, kept honest only by a grep-based
 * drift gate; now a wave that exists here IS on the map, with its own file as the code
 * reference, and inserting/removing/reordering a wave is an edit to this list and nothing else.
 *
 * The ordering encodes three principles, cheapest-first inside each phase:
 * identifiers (a printed DOI settles WHICH work) → local before network → full titles →
 * shortened-title retries (free re-score first, higher accept bar) → the printed URL and its
 * fallback (URL-first can never LOSE a parked match) → open web search last, host-gated
 * against the printed URL.
 */
final class ResolutionLadder
{
    /** @return list<ResolutionWave> in execution order */
    public static function waves(): array
    {
        return [
            // Identifiers first — extract → local drain → network remainder.
            new Waves\DoiFromText(),
            new Waves\LocalDoiLookup(),
            new Waves\OpenAlexDoiLookup(),
            // The docuverse before the internet.
            new Waves\LocalLibraryTitle(),
            new Waves\ReferencedWorksPool(),
            // Phase A: full-title searches across the three indexes.
            new Waves\OpenAlexTitleSearch(),
            new Waves\OpenLibrarySearch(),
            new Waves\SemanticScholarSearch(),
            // Phase B: shortened titles — the restore stamps shortenedTitle for the retries.
            new Waves\ShortenedTitleRestore(),
            new Waves\OpenAlexTitleShortened(),
            new Waves\OpenLibraryShortened(),
            new Waves\SemanticScholarShortened(),
            // Phase C: the printed URL gets first refusal, then its parked-match fallback,
            // then the open web.
            new Waves\PrintedUrlFetch(),
            new Waves\UrlFirstFallback(),
            new Waves\BraveSearchFallback(),
        ];
    }
}

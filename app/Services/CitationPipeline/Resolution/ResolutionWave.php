<?php

namespace App\Services\CitationPipeline\Resolution;

/**
 * One rung of the citation resolution ladder.
 *
 * The waves were inline blocks inside one 1,596-line method, which had three consequences worth
 * naming, because they are what this interface is for:
 *
 * 1. NOTHING COULD POINT AT A WAVE. `ResolutionLadderMap` had eight of its stations citing
 *    `CitationScanBibliographyJob.php::handle` — a code reference with no page number. The
 *    reader-facing citation review is meant to link each step to the source on GitHub so a reader
 *    can check us; that promise is empty while every link lands in the same method.
 *
 * 2. THE MAP HAD TO BE HAND-DECLARED, and kept honest by a test that greps the source for
 *    `Log::info('Wave N: …')` literals. Once a wave is a class it DESCRIBES ITSELF, the map is
 *    derived, and the drift gate changes from "does the declaration match a grep" to "is every
 *    wave class described" — a much stronger contract, and one that can carry the EDGES a real
 *    diagram needs.
 *
 * 3. THE TRACE COULD ONLY EVER BE A CONVENTION. The per-citation trace needs every wave to record
 *    entered / skipped-with-reason / outcome; in inline blocks nothing prevents a new wave from
 *    forgetting. A base that records around `run()` makes a wave that does not trace
 *    unrepresentable.
 *
 * The declarative half (`title`/`plain`/`dev`/gates) is not documentation — it is the data the map,
 * the workbench diagram and the reader's report all read. `plain` is written for someone reading a
 * review of their own citations; `dev` for us.
 */
/**
 * NAMING: A WAVE IS NAMED FOR ITS JOB, NEVER ITS POSITION.
 *
 * Classes are `OpenAlexDoiLookup`, `OpenLibrarySearch`, `PrintedUrlFetch` — not `Wave2b`,
 * `Wave5`, `Wave6`. The ordinal scheme has ALREADY failed once in this very ladder: the waves are
 * numbered 1, 2a, 2b, 3, 3.5, 4, 4b, 5, 5b, 6, 7, 7b, 8, and every letter suffix and fraction in
 * that list is an insertion that could not afford to renumber what came after it. Encoding
 * position in a name means the name is wrong the first time the order changes, and the cost of
 * being right is renaming every file below the insertion point.
 *
 * ORDER LIVES IN EXACTLY ONE PLACE — the array the job iterates. That is the only thing that
 * should have to change when a wave is inserted, removed or reordered.
 *
 * The `id()` rule is stricter, because an id is not just a name: the per-citation trace records
 * against it, so it ends up PERSISTED in `match_diagnostics` and rendered in a reader's citation
 * review. An ordinal id would be baked into stored data, and renaming it later would leave every
 * historical trace pointing at a stage that no longer exists. `log_marker` in ResolutionLadderMap
 * is the one place an ordinal survives, deliberately: it is the operator-facing string the job
 * already emits and the drift gate's anchor, and it is a LABEL rather than an identity.
 */
interface ResolutionWave
{
    /**
     * Stable id — the vocabulary the trace records against and the map keys on.
     *
     * Functional and permanent: `openalex_doi_lookup`, not `wave2b_openalex_doi`. This string
     * reaches persisted diagnostics and a reader-facing report, so treat a change to it as a
     * data migration rather than a rename.
     */
    public function id(): string;

    /** Short human name, e.g. "Wave 2b — OpenAlex DOI lookup". */
    public function title(): string;

    /** What this wave does, for a reader of a citation review. No jargon. */
    public function plain(): string;

    /** What this wave does, for us. */
    public function dev(): string;

    /** What must be true for this wave to run at all. */
    public function entryGate(): string;

    /** What this wave accepts as a match. "None — routes only" for a wave that cannot match. */
    public function acceptGate(): string;

    /**
     * The literal `Log::info('Wave N: …')` prefix this wave emits, or null for a wave that logs
     * no numbered marker. The ONE place an ordinal survives — it is the operator-facing log
     * string and the drift gate's anchor (the gate asserts the marker a class declares is
     * actually emitted by that class's own file), a LABEL rather than an identity.
     */
    public function logMarker(): ?string;

    /**
     * NON-SEQUENTIAL edges only, as [['to' => <stage id or terminal>, 'label' => <why>], …].
     *
     * The sequential fall-through (this wave → the next in the ladder, "nothing accepted") and
     * the accept edge (this wave → resolved) are DERIVED by ResolutionLadderMap::edges() from
     * the ladder's order — declaring them here would be a second copy of the order this
     * architecture exists to keep in one place. What belongs here is only what the order cannot
     * express: a parked match surfacing at the URL-first fallback, a descent into the
     * acquisition rungs.
     */
    public function edges(): array;

    /** Whether there is anything for this wave to do. */
    public function shouldRun(ResolutionContext $ctx): bool;

    /** Resolve what it can, removing what it claims from `$ctx->pool`. */
    public function run(ResolutionContext $ctx): void;
}

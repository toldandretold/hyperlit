<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\AnnotationReattachmentService;

/**
 * The ONE place that says whether a candidate may be minted without a human:
 * used by both the console's batch-approve endpoint and the detect job's
 * --auto-approve mode, so the rule cannot fork. Deliberately conservative —
 * an exact, unambiguous, quote-bearing INLINE match of real length. The
 * candidate table keeps every match feature alongside every human verdict, so
 * this rule can grow into a learned confidence threshold without a schema
 * change.
 *
 * Blockquotes are excluded on purpose. An inline quote's marks are a boundary
 * the citing AUTHOR wrote: the words between them are the borrowed ones, and
 * locating them in the source confirms both the quote and its attribution. A
 * blockquote carries no such boundary — QuoteDetector infers the attribution
 * positionally (marker inside the block, or in the adjacent node's first/last
 * sentence with no competing marker) and infers the extent by stripping
 * furniture. Both inferences are good enough to propose and not good enough to
 * mint unattended: a wrong one hangs a hypercite off the wrong work. They go to
 * the console for a human verdict instead.
 */
class AutoApprovePolicy
{
    public static function qualifies(object $candidate): bool
    {
        if (! $candidate->has_quote || $candidate->status !== 'matched') {
            return false;
        }
        if (($candidate->quote_kind ?? null) !== 'inline') {
            return false;
        }
        if ($candidate->match_method !== 'exact') {
            return false;
        }
        if ((int) $candidate->match_occurrences !== 1) {
            return false;
        }

        $normLen = mb_strlen(AnnotationReattachmentService::normalize((string) $candidate->quote_text)['text']);

        return $normLen >= (int) config('hypercites.auto_approve_min_quote_chars', 40);
    }
}

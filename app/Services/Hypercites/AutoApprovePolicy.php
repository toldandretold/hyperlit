<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\AnnotationReattachmentService;

/**
 * The ONE place that says whether a candidate may be minted without a human:
 * used by both the console's batch-approve endpoint and the detect job's
 * --auto-approve mode, so the rule cannot fork. Deliberately conservative —
 * an exact, unambiguous, quote-bearing match of real length. The candidate
 * table keeps every match feature alongside every human verdict, so this rule
 * can grow into a learned confidence threshold without a schema change.
 */
class AutoApprovePolicy
{
    public static function qualifies(object $candidate): bool
    {
        if (! $candidate->has_quote || $candidate->status !== 'matched') {
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

<?php

namespace App\Services\CitationReview\Support;

/**
 * Format seconds into a human-readable duration string.
 * Extracted verbatim from CitationReviewService::formatDuration.
 */
final class DurationFormatter
{
    public function format(int $seconds): string
    {
        if ($seconds < 60) {
            return "{$seconds}s";
        }

        $minutes = intdiv($seconds, 60);
        $secs = $seconds % 60;

        if ($minutes < 60) {
            return $secs > 0 ? "{$minutes}m {$secs}s" : "{$minutes}m";
        }

        $hours = intdiv($minutes, 60);
        $mins = $minutes % 60;
        return $mins > 0 ? "{$hours}h {$mins}m" : "{$hours}h";
    }
}

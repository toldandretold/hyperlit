<?php

namespace App\Helpers;

class SubBookIdHelper
{
    /**
     * Build a sub-book ID from a parent book and item ID.
     *
     * Level 1: parentBook has no '/' → "parentBook/itemId"
     * Level 2+: parse parent to get foundation + depth → "foundation/(parentLevel+1)/parentItemId/itemId"
     */
    public static function build(string $parentBook, string $itemId): string
    {
        $parsed = self::parseParent($parentBook);

        if ($parsed === null) {
            // Level 1: parentBook is a plain foundation (no '/')
            return $parentBook . '/' . $itemId;
        }

        // Level 2+
        $newLevel = $parsed['level'] + 1;
        return $parsed['foundation'] . '/' . $newLevel . '/' . $parsed['lastItemId'] . '/' . $itemId;
    }

    /**
     * Parse a sub-book ID into its components.
     *
     * Returns: ['foundation', 'level', 'parentItemId', 'itemId']
     */
    public static function parse(string $subBookId): array
    {
        $parts = explode('/', $subBookId);

        if (count($parts) === 2) {
            // Level 1: "foundation/itemId"
            return [
                'foundation'   => $parts[0],
                'level'        => 1,
                'parentItemId' => null,
                'itemId'       => $parts[1],
            ];
        }

        if (count($parts) === 4) {
            // Level 2+: "foundation/N/parentItemId/itemId"
            return [
                'foundation'   => $parts[0],
                'level'        => (int) $parts[1],
                'parentItemId' => $parts[2],
                'itemId'       => $parts[3],
            ];
        }

        // Fallback: treat the whole string as foundation with no item
        return [
            'foundation'   => $subBookId,
            'level'        => 0,
            'parentItemId' => null,
            'itemId'       => null,
        ];
    }

    /**
     * Parse a parent book string to extract foundation, level, and last item ID.
     * Returns null if the parent is a plain foundation (no '/').
     */
    private static function parseParent(string $parentBook): ?array
    {
        if (!str_contains($parentBook, '/')) {
            return null;
        }

        $parts = explode('/', $parentBook);

        if (count($parts) === 2) {
            // Parent is level 1: "foundation/itemId"
            return [
                'foundation' => $parts[0],
                'level'      => 1,
                'lastItemId' => $parts[1],
            ];
        }

        if (count($parts) === 4) {
            // Parent is level 2+: "foundation/N/parentItemId/itemId"
            return [
                'foundation' => $parts[0],
                'level'      => (int) $parts[1],
                'lastItemId' => $parts[3],
            ];
        }

        // Unknown format — treat as level 1 with last segment as itemId
        return [
            'foundation' => $parts[0],
            'level'      => 1,
            'lastItemId' => end($parts),
        ];
    }
}

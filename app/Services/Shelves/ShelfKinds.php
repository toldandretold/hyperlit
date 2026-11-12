<?php

namespace App\Services\Shelves;

/**
 * Shelf kinds whose MEMBERSHIP is owned by a system writer (LikesShelf, LicenceReviewShelf):
 * the owner may not hand-add to or delete them. Every guard asks here instead of comparing
 * to 'likes', so a new system kind is one line.
 */
final class ShelfKinds
{
    public const USER = 'user';

    public const SYSTEM = [LikesShelf::KIND, LicenceReviewShelf::KIND];

    public static function isSystem(?object $shelf): bool
    {
        return in_array($shelf->kind ?? self::USER, self::SYSTEM, true);
    }
}

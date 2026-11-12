<?php

return [
    /*
     * The book (id or slug) explaining Hyperlit's position on copyright — pinned first on every
     * user's "Might not be OK to publish" shelf (App\Services\Shelves\LicenceReviewShelf) and
     * the target of its notification. Static pages are books: write it in-app, then set this.
     * Unset → the shelf just holds the flagged books.
     */
    'copyright_explainer_book' => env('LICENSING_COPYRIGHT_BOOK'),
];

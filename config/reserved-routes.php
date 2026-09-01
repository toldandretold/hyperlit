<?php

/*
|--------------------------------------------------------------------------
| Reserved root path segments
|--------------------------------------------------------------------------
|
| Hyperlit's URL space belongs to books: anything unmatched falls through to
| the /{identifier} catch-all in routes/web.php and is looked up as a book (or
| a legacy username). So EVERY literal first path segment the app registers is
| a word that a book, slug, or username can never have — a book slugged
| "maintainer" would simply be shadowed by the route and become unreachable.
|
| This list is the single source of truth for that set. It is consumed by:
|   - DbLibraryController::setSlug      (vanity slug validation)
|   - AuthController::register          (username validation)
|   - tests/Feature/Routing/ReservedRoutesTest.php
|
| That test walks the real route table and fails if any literal first segment
| is missing here — which is what stops this list going stale the way its
| hand-maintained predecessor did (it never learned about /q, /3d or /dev).
|
| Adding a root-level route? Add its first segment here, and prefer a PREFIXED
| namespace (/q/…, /3d/…, /maintainer/…) so you spend one word instead of one
| word per page.
|
*/

return [
    // Framework / infrastructure
    'api',
    'broadcasting',
    'sanctum',
    'up',
    'storage',
    'build',

    // Auth
    'login',
    'logout',
    'register',
    'resend',
    'reset-password',
    'email',

    // Core pages + feeds
    'home',
    'og',
    'sitemap.xml',
    'sitemap',
    'offline',

    // Import
    'import-file',
    'import-url',

    // Prefixed namespaces (one word each, pages live a segment deeper)
    '3d',        // docuverse
    'q',         // quantizer
    'u',         // user pages
    'based',     // standalone sub-book view
    'dev',       // developer tools (/dev/conversion-tests)
    'maintainer', // operator triage (/maintainer/conversion, /maintainer/jobs)
    'j',         // journal pages (/j/{slug} — planned; slugs already minted in journal_sources)
    'a',         // archive pages (/a/{slug} — archive_sources registry over public shelves)

    // Data + misc
    'books',
    'db',
    'user',
    'stripe',
];

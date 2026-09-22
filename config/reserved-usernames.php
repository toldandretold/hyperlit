<?php

/*
|--------------------------------------------------------------------------
| Reserved usernames (impersonation blocklist)
|--------------------------------------------------------------------------
|
| This list is DELIBERATELY SEPARATE from config/reserved-routes.php. The two
| answer different questions:
|
|   - reserved-routes  → "would this name shadow a URL the app registers?"
|     (a book slugged "maintainer" is unreachable behind /maintainer)
|   - reserved-usernames (this file) → "could this name impersonate someone or
|     something official?" (a user named "admin" or the owner's own handle)
|
| They must not be merged. If they were one list, every new root route would
| silently widen the impersonation blocklist, and every reserved identity would
| silently claim a URL segment — each change leaking into a set it has nothing
| to do with. Keeping them apart is what makes each one auditable on its own.
|
| Why this exists: on 2026-09-22 an actor registered `admin`, `root`, `test`
| and `marx` (the owner's handle) in four seconds. Registration validated names
| against reserved-routes ONLY, and none of those are routes — so an
| impersonation defence had been resting on a list built for URL collisions,
| which never covered it. No privilege came with the names (the admin check
| reads users.is_admin, not the username), but they became official-looking
| pages on the domain.
|
| Consumed by:
|   - AuthController::register        (username validation)
|   - DbLibraryController::setSlug    (a book slug is reachable at /{slug} too,
|                                      so the same impersonation risk applies)
|   - tests/Feature/Security/ReservedUsernamesTest.php
|
| Matching is case-insensitive at the call site (usernames are compared
| lowercased), so entries here are lowercase.
|
*/

return [
    // Roles / authority
    'admin',
    'administrator',
    'root',
    'moderator',
    'mod',
    'staff',
    'official',
    'system',
    'security',
    'support',
    'help',
    'billing',
    'abuse',

    // Infra / service identities
    'api',
    'www',
    'noreply',
    'no-reply',
    'postmaster',
    'webmaster',
    'mailer-daemon',

    // Brand / owner
    'hyperlit',
    'marx',

    // Generic placeholders that read as "not a real person"
    'test',
    'guest',
    'anonymous',
    'anon',
];

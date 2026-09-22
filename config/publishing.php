<?php

/*
|--------------------------------------------------------------------------
| Publishing gate
|--------------------------------------------------------------------------
|
| Making a book PUBLIC (visibility => 'public' / listed => true) requires a
| verified email — but only for accounts created AFTER the cutoff below.
|
| Why a cutoff instead of a blanket rule: email verification was wired from the
| start (User implements MustVerifyEmail, register() sends the link) but never
| enforced, so most existing accounts never clicked it. Enforcing retroactively
| would strand real users mid-session on books they were about to publish.
| Grandfathering by created_at applies the rule ONLY to accounts that signed up
| under it — which is exactly the population an abuser draws from.
|
| Anonymous (not-logged-in) users can never publish, regardless of this cutoff:
| if a logged-in user must verify an email to publish, a visitor with no
| identity at all cannot. Anon book CREATION and anon HIGHLIGHTS are unaffected.
|
| The cutoff is an env-overridable ISO-8601 instant. A NULL/empty cutoff turns
| the gate OFF entirely (anyone, including anon, may publish) — this is the
| default OUTSIDE production, so local dev and the e2e suite are not hampered by
| a verification requirement. In PRODUCTION the default is a historical instant,
| so the gate is fail-safe ON even if the operator never sets the env var (the
| whole point: a security control must not rest on someone remembering to enable
| it). Set PUBLISHING_VERIFY_AFTER on the droplet to pin it to the real deploy
| time. Feature tests set this config explicitly and are unaffected by the
| environment default.
|
| Consumed by:
|   - DbLibraryController::publishPermission  (visibility/listed write + bulkCreate)
|   - tests/Feature/Security/PublishPermissionTest.php
|
*/

return [
    /*
     * Accounts created at or after this instant must verify their email before
     * making a book public; earlier accounts are grandfathered. NULL disables
     * the gate. Parsed with Carbon::parse().
     */
    'verified_email_required_after' => env(
        'PUBLISHING_VERIFY_AFTER',
        env('APP_ENV') === 'production' ? '2026-09-22T00:00:00Z' : null,
    ),
];

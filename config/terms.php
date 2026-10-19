<?php

/*
|--------------------------------------------------------------------------
| Terms of Service version
|--------------------------------------------------------------------------
|
| The effective date of the CURRENT terms, as a date string. It MUST match
| the "Effective ..." line atop docs/terms-page.md and the live /terms book
| — three copies of one fact, this one being what registration stamps into
| users.terms_version and what terms:announce writes as the notification's
| subject_id (which is also the dedupe key, so re-announcing one version can
| never double-notify anyone).
|
| Changing this value for a material change creates a DUTY, promised in the
| terms themselves: run `php artisan terms:announce --force` at least 30
| days BEFORE the new date takes effect, after updating the /terms book.
|
| A literal, not env(): the version is bound to the published documents and
| this repo's git history, not to any one environment.
|
*/

return [
    'version' => '2026-11-17',
];

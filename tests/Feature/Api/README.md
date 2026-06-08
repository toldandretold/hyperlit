# API endpoint test suite

Per-endpoint tests for Hyperlit's HTTP API. Part of the Pest `Feature` suite —
runs with `php artisan test`, against the real Postgres test DB with
`RefreshDatabase`, queue `sync` (see `phpunit.xml`).

```bash
php artisan test tests/Feature/Api/                 # this suite only
php artisan test tests/Feature/Api/ImportApiTest.php # one file
php artisan test --testsuite=Feature                 # everything
php artisan test --group=concurrency                 # live harness, needs Herd up (see below)
```

## What these tests assert

For each endpoint, where applicable:
- **auth** — a guest (or wrong owner) is rejected with the right status.
- **validation** — bad/missing input returns the documented error status.
- **happy path** — status code + JSON *structure* the SPA depends on.
- **ownership / RLS** — you can't read or mutate another author's book.
- **idempotency / concurrency** — re-issuing a job-dispatch endpoint behaves
  (in-process guard tests; true parallelism lives in the live harness).

These are **characterization tests**: they pin *current* behaviour. Where current
behaviour is a known wart (inconsistent error shapes, missing job-uniqueness
guards) the test documents it and links to
[`docs/api-restructure-findings.md`](../../../docs/api-restructure-findings.md)
rather than failing red. Standardising the API is a deferred, separate effort.

## Shared helpers

`Support/InteractsWithApi.php` is bound to every test in this folder (via
`tests/Pest.php`). Inside a test closure:

- `$this->loginUser([...])` — create a user (admin/BYPASSRLS connection) and
  `actingAs` them. Returns the `User`.
- `$this->apiUser([...])` — create a user without authenticating.
- `$this->anonSession()` — establish an anonymous session the way the SPA does;
  returns `['token', 'response']` and sets the `anon_token` cookie.
- `$this->makeBook($owner, [...])` — seed a `library` row (owned if `$owner` is a
  `User`, anonymous if a token string); returns the bookId. Default seeds via
  `pgsql_admin` (committed, visible to controllers that read the library through
  `pgsql_admin`, e.g. the citation scanner). **If the controller-under-test writes
  the row through the default connection** (e.g. `reconvert`), pass
  `['via' => 'app']` — otherwise the admin-committed row is lock-held by that
  write at teardown and the `afterEach` cleanup deadlocks against it. (Learned the
  hard way: `kill -9` on a deadlocked run leaves `idle in transaction` Postgres
  backends holding the lock, which then hangs every *subsequent* run until you
  `pg_terminate_backend` them.)
- `$this->assertApiError($response, 422)` — assert an error *status* without
  locking in a body shape (shapes vary today — finding F5).

Why a BYPASSRLS connection: the `users` and `library` tables block INSERT from the
app's `pgsql` role, so fixtures must be seeded via `pgsql_admin`. After an
authenticated HTTP request, `SetDatabaseSessionContext` has set the RLS context on
the default connection, so post-request Eloquent assertions see the rows.

## Live concurrency + latency harness

`Concurrency/` holds tests tagged `->group('concurrency')`, **excluded from the
default run**. They fire genuinely-simultaneous requests at a *running* server
(`Http::pool()`), which the in-process sync-queue tests can't do. They are
non-deterministic and **must not gate CI**.

```bash
# Start Herd (or any server), then:
HYPERLIT_TEST_URL=http://hyperlit.test php artisan test --group=concurrency
```

---

## Coverage matrix

Status: ✅ done · 🟡 partial · ⬜ none. "Covered by" names the test file.
Async = the queued job an endpoint dispatches (concurrency-sensitive).

### A. Auth & user
| M | URI | Controller@method | Auth | Status | Covered by |
|---|-----|-------------------|------|--------|-----------|
| POST | /api/login | AuthController@login | throttle | 🟡 | Auth/AuthenticationTest |
| POST | /api/register | AuthController@register | throttle | 🟡 | Auth/RegistrationTest |
| POST | /logout | AuthController@logout | sanctum | 🟡 | AuthEmailApiTest (auth) — note: /logout, not /api/logout |
| GET | /user | AuthController@user | sanctum | ✅ | AuthEmailApiTest — note: /user, not /api/user |
| POST | /api/anonymous-session | AuthController@createAnonymousSession | — | ✅ | AuthApiContractTest |
| GET | /api/auth-check | AuthController@checkAuth | — | ✅ | AuthApiContractTest |
| GET | /api/auth/session-info | AuthController@getSessionInfo | — | ✅ | AuthApiContractTest |
| POST | /api/auth/associate-content | AuthController@associateContent | sanctum | 🟡 | Security/AnonymousContentAssociationTest |
| POST | /api/email/resend | AuthController@resendVerificationEmail | sanctum | 🟡 | AuthEmailApiTest (auth) |
| POST | /api/email/change | AuthController@changeEmail | sanctum | 🟡 | AuthEmailApiTest (auth) |
| POST | /api/password/forgot | AuthController@forgotPassword | throttle | 🟡 | Auth/PasswordResetTest |
| POST | /api/password/reset | AuthController@resetPassword | throttle | 🟡 | Auth/PasswordResetTest |
| POST | /books/{book}/transfer-ownership | AuthController@transferBookOwnership | sanctum | 🟡 | AuthEmailApiTest (auth) |

### B. Import & conversion — async: ProcessDocumentImportJob
| M | URI | Controller@method | Auth | Status | Covered by |
|---|-----|-------------------|------|--------|-----------|
| POST | /import-file | ImportController@store | author | 🟡 | Import/ImportPipelineTest |
| GET | /api/import-progress/{book} | ImportController@importProgress | throttle | ✅ | ImportApiTest |
| POST | /api/import-progress/{book}/notify | ImportController@requestEmailNotification | throttle | ✅ | ImportApiTest |
| POST | /import-url/inspect | UrlImportController@inspect | author | 🟡 | ImportUrlCitationApiTest (auth/422) |
| POST | /import-url | UrlImportController@commit | author | 🟡 | ImportUrlCitationApiTest (422) |
| GET | /api/books/{book}/reconvert-info | ImportController@reconvertInfo | author | ✅ | ImportUrlCitationApiTest |
| POST | /api/books/{book}/reconvert | ImportController@reconvert | author | ✅ | ImportApiTest (auth/owner/dispatch; F1/F4) |

### C. Vibe conversion — async: VibeConversionJob (queue: vibe)
| M | URI | Controller@method | Auth | Status | Covered by |
|---|-----|-------------------|------|--------|-----------|
| POST | /api/vibe-convert/start | VibeConvertController@start | sanctum | ✅ | VibeConvertApiTest (auth/billing/dispatch; F1) |
| GET | /api/vibe-convert/progress/{book} | VibeConvertController@progress | sanctum | 🟡 | VibeConvertApiTest (auth) |
| POST | /api/vibe-convert/cancel/{book} | VibeConvertController@cancel | sanctum | 🟡 | VibeConvertApiTest (auth) |
| POST | /api/vibe-convert/use-now/{book} | VibeConvertController@useNow | sanctum | 🟡 | VibeConvertApiTest (auth) |
| POST | /api/vibe-convert/notify/{book} | VibeConvertController@notify | sanctum | 🟡 | VibeConvertApiTest (auth) |
| POST | /api/vibe-convert/accept | VibeConvertController@accept | sanctum | 🟡 | VibeConvertApiTest (auth/validation) |
| GET | /api/vibe-convert/review/{book} | VibeConvertController@review | sanctum | ✅ | VibeConvertApiTest |
| POST | /api/vibe-convert/review/{book}/keep | VibeConvertController@keepReview | sanctum | 🟡 | VibeConvertApiTest (auth) |
| POST | /api/vibe-convert/review/{book}/reject | VibeConvertController@rejectReview | sanctum | 🟡 | VibeConvertApiTest (auth) |

### D. Citations — async: CitationScanBibliographyJob, CitationPipelineJob
| M | URI | Controller@method | Auth | Status | Covered by |
|---|-----|-------------------|------|--------|-----------|
| POST | /api/citation-scanner/scan | CitationScannerController@scan | sanctum | ✅ | CitationApiTest (auth/validation/guard; F2) |
| GET | /api/citation-scanner/status/{scanId} | CitationScannerController@status | sanctum | 🟡 | CitationApiTest (404) |
| GET | /api/citation-scanner/history/{book} | CitationScannerController@history | sanctum | ✅ | ImportUrlCitationApiTest |
| POST | /api/citation-pipeline/trigger | CitationScannerController@triggerPipeline | sanctum | ✅ | CitationApiTest (auth/billing/guard; F2) |
| GET | /api/citation-pipeline/status/{pipelineId} | CitationScannerController@pipelineStatus | sanctum | 🟡 | CitationApiTest (404) |
| GET | /api/citation-pipeline/running/{book} | CitationScannerController@pipelineRunning | sanctum | ✅ | ImportUrlCitationApiTest |
| POST | /api/citation-pipeline/resume/{pipelineId} | CitationScannerController@resumePipeline | sanctum | 🟡 | ImportUrlCitationApiTest (auth/404) |

### E. Search (public, throttled)
| M | URI | Controller@method | Status | Covered by |
|---|-----|-------------------|--------|-----------|
| GET | /api/search/library | SearchController@searchLibrary | ✅ | SearchApiTest |
| GET | /api/search/nodes | SearchController@searchNodes | ✅ | ImportUrlCitationApiTest |
| GET | /api/search/openalex | OpenAlexController@search | 🟡 | OpenAlexCanonicalApiTest (422) |
| GET | /api/search/combined | SearchController@searchWithOpenAlex | 🟡 | SearchApiTest (validation) |

### F. Database → IndexedDB (read path the SPA boots from)
| M | URI | Controller@method | Status | Covered by |
|---|-----|-------------------|--------|-----------|
| GET | /api/database-to-indexeddb/books | …@getAvailableBooks | ✅ | DatabaseToIndexedDBApiTest |
| GET | /api/database-to-indexeddb/books/{book}/data | …@getBookData | ✅ | DatabaseToIndexedDBApiTest (404/403) |
| GET | /api/database-to-indexeddb/books/{book}/metadata | …@getBookMetadata | ✅ | DatabaseToIndexedDBApiTest (404) |
| GET | /api/database-to-indexeddb/books/{book}/library | …@getBookLibrary | ✅ | DatabaseToIndexedDBApiTest (404) |
| GET | /api/database-to-indexeddb/books/{book}/annotations | …@getBookAnnotations | ✅ | DatabaseToIndexedDBApiTest (403) |
| GET | /api/database-to-indexeddb/books/{book}/headings | …@getBookHeadings | ✅ | DatabaseToIndexedDBApiTest (404) |
| GET | /api/database-to-indexeddb/books/{book}/initial | …@getInitialChunk | ✅ | DatabaseToIndexedDBApiTest (404) |
| GET | /api/database-to-indexeddb/books/{book}/chunk/{chunkId} | …@getSingleChunk | 🟡 | DatabaseToIndexedDBApiTest (route constraint) |
| GET | /api/database-to-indexeddb/books/{book}/data/batch | …@getBookDataBatch | ✅ | DatabaseToIndexedDBApiTest (404) |
| POST/GET | …/{book}/reading-position | …@save/getReadingPosition | 🟡 | DatabaseToIndexedDBApiTest (save 401) |
| GET | …/{parent}/{subId}/* (data/metadata/library/initial/annotations) | …@getSubBook* | ✅ | DatabaseToIndexedDBApiTest (404) |

### G. Library, annotations, nodes, sync (author-gated writes)
| M | URI | Controller@method | Status | Covered by |
|---|-----|-------------------|--------|-----------|
| POST | /api/db/library/upsert | DbLibraryController@upsert | 🟡 | LibraryApiTest (auth/validation) |
| POST | /api/db/library/bulk-create | DbLibraryController@bulkCreate | 🟡 | LibraryApiTest (auth) |
| POST | /api/library/{book}/update-stats | DbLibraryController@updateBookStats | 🟡 | LibraryApiTest (auth) |
| POST | /api/db/library/update-timestamp | DbLibraryController@updateTimestamp | 🟡 | LibraryApiTest (auth/validation) |
| POST | /api/db/library/set-slug | DbLibraryController@setSlug | 🟡 | LibraryApiTest (invalid-slug 422) |
| POST | /api/validate-book-id | DbLibraryController@validateBookId | ✅ | LibraryApiTest |
| DELETE | /api/books/{book} | DbLibraryController@destroy | ✅ | LibraryApiTest (auth/404/403) |
| POST | /api/db/hyperlights/{upsert,bulk-create,delete,hide} | DbHyperlightController@* | ✅ | AnnotationsApiTest (auth/validation; F10) |
| POST | /api/db/hypercites/{upsert,bulk-create} + find | DbHyperciteController@* | ✅ | AnnotationsApiTest (auth/validation) |
| POST | /api/db/footnotes/upsert | DbFootnoteController@upsert | ✅ | AnnotationsApiTest (auth; F10) |
| POST | /api/db/references/upsert | DbReferencesController@upsertReferences | ✅ | AnnotationsApiTest (auth/422) |
| POST | /api/db/node-chunks/{upsert,bulk-create,targeted-upsert} | DbNodeChunkController@* | ✅ | NodeChunkApiTest (auth/validation) |
| POST | /api/db/unified-sync | UnifiedSyncController@sync | 🟡 | SyncApiTest (auth/validation; F8) |
| POST | /api/db/sync/beacon | BeaconSyncController@handleSync | 🟡 | SyncApiTest (auth/422) |

### H. Node history / time machine
| M | URI | Controller@method | Status | Covered by |
|---|-----|-------------------|--------|-----------|
| GET | /api/nodes/{book}/{nodeId}/history | NodeHistoryController@getNodeHistory | 🟡 | NodeHistoryApiTest (auth) |
| GET | /api/books/{book}/changes | NodeHistoryController@getRecentChanges | 🟡 | NodeHistoryApiTest (auth) |
| POST | /api/nodes/{book}/{nodeId}/restore | NodeHistoryController@restoreNodeVersion | 🟡 | NodeHistoryApiTest (auth) |
| POST | /api/books/{book}/restore | NodeHistoryController@restoreBookToTimestamp | 🟡 | NodeHistoryApiTest (auth/400) |
| GET | /api/books/{book}/snapshots | NodeHistoryController@getSnapshots | ✅ | NodeHistoryApiTest (public, 403) |
| GET | /api/books/{book}/timemachine-data | NodeHistoryController@getTimeMachineData | 🟡 | NodeHistoryApiTest (auth/400) |

### I. Shelves, vibes, prefs, billing, integrity, misc
| M | URI | Controller@method | Status | Covered by |
|---|-----|-------------------|--------|-----------|
| GET/POST/PATCH/DELETE | /api/shelves… (+ public render/search) | ShelfController@* | ✅ | ShelfApiTest (auth/validation/404/create; F11) |
| GET/POST/PATCH/DELETE | /api/vibes… (+ public) | VibesController@* | ✅ | VibesApiTest (auth/validation/404/create/public) |
| POST | /api/vibe-css/{generate,can-proceed} | VibeCSSController@* | ✅ | AiVibeCssApiTest (auth/validation/gate) |
| POST | /api/ai-brain/{query,status} | AiBrainController@* | ✅ | AiVibeCssApiTest (auth/validation/404) |
| GET/POST | /api/user/preferences | UserPreferencesController@* | ✅ | UserPreferencesApiTest |
| GET | /api/billing/{balance,ledger,ledger/{id}} | BillingController@* | ✅ | BillingApiTest (auth/shape/404/403/422) |
| POST | /api/billing/checkout | StripeController@createCheckoutSession | 🟡 | AdminHomeStripeApiTest (auth/422) |
| POST | /api/stripe/webhook | StripeController@handleWebhook | ✅ | AdminHomeStripeApiTest (signature 400) |
| POST | /api/integrity/* | IntegrityReportController@* | ✅ | IntegrityApiTest (auth/validation/accept) |
| GET | /api/canonical/{id}/best-version | CanonicalSourceController@bestVersion | ✅ | OpenAlexCanonicalApiTest (404) |
| GET/POST | /api/search/openalex, /api/openalex/{lookup-citation,save-to-library} | OpenAlexController@* | 🟡 | OpenAlexCanonicalApiTest (auth/422) |
| POST | /api/db/sub-books/{create,migrate-existing} | SubBookController@* | ✅ | ScrapeSubBookApiTest (auth/validation) |
| POST | /api/scrape/novel/{chapters,chapter} | ScrapeController@* | 🟡 | ScrapeSubBookApiTest (auth/422) |
| GET/POST | /api/homepage/books{,/update} | HomePageServerController@* | 🟡 | AdminHomeStripeApiTest (auth) |
| POST | /api/conversion-tests/* | ConversionTestController@* | admin | ✅ | AdminHomeStripeApiTest (auth/admin-403) |

> Keep this matrix honest: flip a row to ✅/🟡 in the **same PR** that adds its
> test. The aim is that "⬜" always means genuinely untested.

# End-to-end encrypted books (E2EE)

Encryption is **opt-in per book**, orthogonal to privacy: an ordinary private book stays exactly as it was (RLS-protected, server-searchable by its owner), while a book the user *locks* is encrypted client-side with keys derived from a WebAuthn passkey (PRF extension) — the server, database backups, and admins only ever see ciphertext. An encrypted book is *forced* private/unlisted/slug-less as a consequence, but private ≠ encrypted.

The client is the encryption boundary. IndexedDB deliberately stays **plaintext** (the local device is trusted; editing, offline mode, and in-book search work untouched); encryption happens at the sync boundary — encrypt on upload, decrypt on download.

## Key hierarchy (all client-side; server stores only wrapped blobs)

```
passkey PRF output (32B, never leaves the device)
  └─ HKDF-SHA256(salt = per-credential prf_salt, info "hlenc/kek/v1") → KEK
recovery code (24-char Crockford base32, shown ONCE, never stored)
  └─ PBKDF2-SHA256 (310k iters) → recovery KEK
vault key (random AES-GCM-256, one per account)
  ├─ wrapped by each passkey's KEK   → passkey_credentials.wrapped_vault_key
  └─ wrapped by the recovery KEK     → user_e2ee_vaults.recovery_wrapped_vault_key
per-book DEK (random AES-GCM-256, per top-level book; sub-books share the root's)
  └─ wrapped by the vault key        → library.wrapped_dek
```

Field encryption is AES-256-GCM, fresh 12-byte IV per write, **AAD = the root book id** (prevents cross-book ciphertext splicing). The unwrapped vault key persists on-device as a NON-extractable CryptoKey in the IDB `e2ee` store, so unlock prompts only appear on fresh devices or after logout (`clearCurrentUser` wipes both the persisted key and the in-memory caches).

## The envelope format

A ciphertext string is self-describing: `hlenc.v1.<b64url iv>.<b64url ct>` — see `resources/js/e2ee/envelope.ts`. JSONB fields wrap as `{"__hlenc__": "hlenc.v1...."}` to stay object-shaped. Envelopes contain no `<`, so `NodeHtmlSanitizer::clean()`'s no-tag early-return passes them untouched. Decryption is detection-based (prefix check), so the download path runs unconditionally and no-ops for plaintext books.

## Module map (client)

- `resources/js/e2ee/envelope.ts` — zero-import leaf: envelope encode/decode/detect.
- `resources/js/e2ee/crypto.ts` — WebCrypto primitives: HKDF/PBKDF2, AES-GCM, key wrap, recovery-code generation.
- `resources/js/e2ee/keys.ts` — vault lifecycle, per-book DEK cache, IDB persistence, `VaultLockedError`.
- `resources/js/e2ee/registry.ts` — zero-import leaf state: `isBookEncrypted()` map the sync emitters consult synchronously; populated by the library loader AND every IDB library read (`getLibraryObjectFromIndexedDB`), so a cached/offline open still knows the flag.
- `resources/js/e2ee/transform.ts` — `FIELD_SPECS`: THE single list of content-bearing fields per store; `encryptUnifiedPayload` / `encryptStoreRows` / `decryptRows`.
- `resources/js/e2ee/outbox.ts` — pre-encrypted mirror for the unload beacon (WebCrypto is async; `sendBeacon` is not — items not yet captured are SKIPPED and stay queued, never sent plaintext).
- `resources/js/e2ee/passkey.ts` — WebAuthn ceremonies. SECURITY: `serializeCredential` strips PRF outputs before anything is POSTed.
- `resources/js/e2ee/lifecycle.ts` — `lockBook` / `publishBook` / `ensureUnlockedForBook` (the reader open-gate).
- `resources/js/e2ee/ui/` — passkey settings panel, unlock modal, recovery-code reveal, locked-card title enhancer.

## The sync seams

Upload (encrypt): `syncQueue/master.ts executeSyncPayload` (covers live-edit unified-sync AND the blocking full sync), `nodes/syncNodesToPostgreSQL.ts`, `serverSync/push.ts` (per-store full-book push), `syncQueue/unload.ts` (beacon, via the outbox), `hyperlitContainer/subBookLoader.ts` (sub-book previewContent), `SPA/createNewBook.ts` (born-encrypted bulk-create).

Download (decrypt): `serverSync/loaders.ts` (all `load*ToIndexedDB` — decrypt runs BEFORE any IDB transaction opens, since an await inside an open tx auto-commits it) and `lazyLoader/chunkFetcher.ts`. Server-rebuilt embedded annotation views are unusable for encrypted books (built from ciphertext charData) — the loaders blank them and `hydration/rebuild` regenerates them from the decrypted local stores.

## Server-side backstops (`app/Services/E2ee/EncryptedBookGuard.php`)

The server can't decrypt, but it enforces: (1) `plainText`/embeddings are never derived for encrypted books (PgNode hook, DbNodeController raw-SQL sites, GenerateNodeEmbedding); (2) **plaintext writes to an encrypted book are 422'd** at every write endpoint — the backstop for a client whose registry failed to populate; (3) `PgLibrary::saving` pins `visibility=private`, `listed=false`, `slug=null` while encrypted; (4) server-side pipelines that read content (vibe convert, citation scan, AI brain, set-slug) 422 for encrypted books. Search exclusion is free: encrypted books are forced private and `SearchService`'s locked privacy contract never returns private books.

Transitions run through `POST /api/db/library/{book}/encryption` (`DbLibraryController::setEncryption`): **encrypt** sets the flags on the whole tree + scrubs plainText/embeddings/`nodes_history`/conversion artifacts, **publish** clears the flags + wrapped DEK; both return the server-truth `tree` list, and the client then PULLS every tree id fully into IDB before re-pushing it (`lifecycle.ts pullBookTree`/`pushBookTree`) — pushing a partial local copy through the nuclear per-store upsert would drop never-downloaded nodes. Publish warms the DEK cache BEFORE the server clears `wrapped_dek` (the final ciphertext pull still needs it). The interim window is private-only. Publishing permanently decrypts; re-locking mints a fresh DEK.

## WebAuthn specifics

Registration is two-phase (`PasskeyController`): `/register` stores the credential + a `prf_salt` (used as BOTH the PRF eval input and the HKDF salt — public values; secrecy lives in the authenticator); one assertion then yields the PRF output client-side, which wraps the vault key → `/passkeys/{id}/vault-key` (first setup carries the recovery blob transactionally). The PRF output **never reaches the server** — `/assert` just verifies the signature and returns that credential's wrapped blob. Adding a second passkey needs one extra assertion with an already-capable passkey (extractable transient unwrap → re-wrap). Deleting the LAST vault-capable passkey is refused (409) — the recovery code isn't a daily driver.

## Known limits / accepted trade-offs

- Structure leaks by design: book ids, node counts/positions, annotation ids, timestamps stay plaintext; content doesn't.
- Beacon loss window: an edit made <~10ms before an abrupt page kill may miss the outbox and stays queued instead (comparable to a failed `sendBeacon`); the `visibilitychange` full flush covers most real page-hides.
- PRF support isn't universal (fine on iCloud Keychain / Windows Hello / Android; some hardware keys lack it) — registration checks `prf.enabled` and refuses vault creation gracefully.
- Server import/conversion can't produce BORN-encrypted books (the pipeline needs plaintext to convert). The shared "Encrypted" checkbox in the +button popup (partials/newbook-container.blade.php) governs Import too — captured into encryptIntent.ts when the cite-form opens; encrypt-after-import is the honest compromise: conversion runs normally, then the client auto-locks the finished book (`ImportBookTransition` → `lockBook`) and the transition scrubs every server-side plaintext residue — `plainText`, embeddings, `nodes_history` temporal rows, and the `resources/markdown/{book}` conversion artifacts. Threat model: the server SAW the book during conversion; nothing recoverable remains at rest afterwards. (Born-encrypted client-side parsing for `.md`/`.txt` is a possible future upgrade.)
- `historyLog` and undo state keep plaintext locally — consistent with the plaintext-IDB decision.

## Tests (the proof)

- `tests/javascript/e2ee/noPlaintextLeaves.test.js` — drives EVERY sync emitter for an encrypted book with sentinel-bearing content and deep-scans every captured request body: zero sentinels, envelope-shaped content fields, beacon skip-and-retain, fail-closed on a locked vault, byte-identical plaintext control.
- `tests/javascript/e2ee/{envelope,keys,transform,loaderDecrypt,outbox}.test.js` — crypto round-trips, tamper/wrong-key/AAD-splice rejection, decrypt-on-download, reload survival.
- `tests/Feature/E2ee/PasskeyCeremonyTest.php` — REAL forged attestations/assertions (CBOR + ES256) through webauthn-lib: replay, foreign-origin, tampered-signature, cross-user rejection.
- `tests/Feature/E2ee/{EncryptionTransitionTest,EncryptedBookExclusionTest,AnnotationTextColumnTest}.php` — transition invariants, 422 plaintext-write guards, embedding/search exclusion, and the opt-in boundary (plain private books unchanged).
- `tests/e2e/specs/e2ee/encrypted-book-lifecycle.spec.js` — manual Playwright run with a CDP virtual authenticator (`hasPrf`): register → recovery code → born-encrypted book → wire-level leak scan → fresh-device unlock.

Test-harness gotcha: Pest E2ee tests assert app-written state via the DEFAULT connection — the `RefreshDatabase` transaction holds row locks, so a `pgsql_admin` write to the same rows deadlocks (and admin reads see stale pre-transaction data).

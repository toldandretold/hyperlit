# Privacy

Effective 15 October 2026

This is the SOURCE for the public privacy page. It is published as a Hyperlit book at `/privacy` (the `/license2025content` pattern — a book served through the catch-all, no route, no reservation), created and owned on prod by the operator. Paste this markdown into that book; when practices change, update `docs/privacy-policy.md` (the code-annotated engineering version) FIRST, then mirror the prose here and in the live book.

## The short version

Your data is yours. Everything you write is private by default; nothing becomes public unless you publish it. We don't sell data, we don't run ad trackers, and we don't share your content with anyone except the specific services you choose to invoke (like AI features), which are listed below. End-to-end encrypted books are excluded from every server-side and third-party process — we hold only ciphertext we cannot read. You can export everything, and you can delete your account.

## What we collect

**Account.** Exactly three things when you register: a username, an email address, and a password (stored as a bcrypt hash). If you set up a passkey for encrypted books, we store only the public key and a wrapped vault key we cannot unwrap. *(code: [`AuthController.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/AuthController.php), [`CreateNewUser.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Actions/Fortify/CreateNewUser.php), [`E2eeVaultController.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/E2eeVaultController.php))*

**Your content.** Books you import or write, highlights, citations, shelves — stored so we can sync and serve them back to you, governed by the visibility you choose per book.

**Reading telemetry.** To count views honestly, we record at most one row per book (or page) per reader per day — just "this identity opened this book on this date" plus which sections were seen. Your identity for this is stamped server-side and never taken from the browser. After 90 days, these records are automatically aggregated into anonymous daily counts and the identity-linked rows are deleted — so "who read what" is something we only ever know for the recent past, by design. We also store your reading position per book so you can resume where you left off. *(code: [`ReadingTelemetryController.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/ReadingTelemetryController.php), [`PageViewController.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/PageViewController.php), [`TelemetryRollup.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Console/Commands/TelemetryRollup.php))*

**Anonymous visitors.** If you use Hyperlit without an account, we set an `anon_token` cookie (a random identifier, HttpOnly, 90-day lifetime) so your highlights and reading positions work without a login. The server-side record for it includes the IP address and browser user-agent it was created from, and is deleted 30 days after its last use. *(code: [`AnonToken.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Support/AnonToken.php), [`CleanupAnonymousSessions.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Console/Commands/CleanupAnonymousSessions.php))*

**Server logs.** Like every website, our servers keep standard operational logs that include IP addresses (used for rate limiting and abuse prevention). Application logs may record IPs around authentication events. Logs stay on our own infrastructure — we use no third-party error-reporting service. *(code: [`logging.php`](https://github.com/toldandretold/hyperlit/blob/main/config/logging.php))*

**What stays on your device.** Your local reading library (IndexedDB), reading positions, interface preferences, and tab identifiers live in your browser's own storage and are not telemetry — they exist so Hyperlit works offline and feels instant.

## What we don't do

No advertising, no ad trackers, no selling or renting data, no Google Analytics, no fingerprinting, no third-party error reporting. 

Database row-level security means the database itself — not just application code — enforces that no other user can read your private data, even through an application bug in a query. *(code: [`SetDatabaseSessionContext.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Middleware/SetDatabaseSessionContext.php), [`pgsql_admin-schema.sql`](https://github.com/toldandretold/hyperlit/blob/main/database/schema/pgsql_admin-schema.sql))*

One honest limit: like any hosted service, the people who administer the server can technically access the database, so an ordinary private book is private from everyone *except* the operator. We do not browse your private work, but you shouldn't have to take our word for it. For that, use our end-to-end encryption. You can encrypt a book at any time, or encrypt it on creation. This requires first setting up a passkey.

## Analytics

We use Cloudflare Web Analytics, a cookieless, non-fingerprinting page-view counter. It tells us how many visitors pages get. It does not identify you, set cookies, or track you across sites. It is the only third-party script on the page. *(code: [`layout.blade.php`](https://github.com/toldandretold/hyperlit/blob/main/resources/views/layout.blade.php))*

## When your content leaves our server

Core reading, writing, highlighting, and citing never involve a third party. Some optional features send specific content to external processors when you invoke them:

- **PDF import (OCR)** — pages of the PDF you upload currently go to Mistral's OCR API for conversion. (planning to offer open source and local alternatives) *(code: [`services.php`](https://github.com/toldandretold/hyperlit/blob/main/config/services.php))*
- **AI features** (citation review, AI archivist, in-text questions, semantic search embeddings) — the relevant passages or node text go to the configured inference provider (currently Fireworks AI; DeepInfra is an alternative transport). We use open-weight models, and both providers state that prompts and outputs are not stored and not used for training: Fireworks holds them in memory only for the duration of the request ([their zero-data-retention policy](https://docs.fireworks.ai/guides/security_compliance/data_handling)), and DeepInfra likewise deletes inputs and outputs after the request completes ([their data-privacy policy](https://docs.deepinfra.com/account/data-privacy)). *(code: [`LlmService.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/LlmService.php), [`services.php`](https://github.com/toldandretold/hyperlit/blob/main/config/services.php))*
- **Audiobooks** — node text goes to a text-to-speech model (Kokoro, via DeepInfra). *(code: [`DeepInfraKokoroProvider.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/Tts/DeepInfraKokoroProvider.php))*
- **Translation** — passages go to the configured provider; a local-model option exists and is the only option for encrypted books. *(code: [`BookTranslationService.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/Translation/BookTranslationService.php))*
- **Citation resolution** — constructed bibliographic queries (title, author, year — not your prose) go to search and scholarly-metadata services such as Brave Search, OpenAlex, and Unpaywall. *(code: [`BraveSearchService.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/BraveSearchService.php))*

**End-to-end encrypted books are excluded from all of this.** For a book you lock with a passkey, the server holds only ciphertext: it cannot derive search text or embeddings from it, and every server-side pipeline — AI features, OCR re-processing, text-to-speech, server-side translation, public URLs — refuses encrypted books outright. One honest caveat: the import pipeline needs plaintext to convert a document, so a book you import *and then* encrypt was visible to the server (and, for PDFs, to the OCR provider) once, during conversion; locking it afterwards scrubs every server-side plaintext residue we hold. *(code: [`EncryptedBookGuard.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/E2ee/EncryptedBookGuard.php), [`e2ee.md`](https://github.com/toldandretold/hyperlit/blob/main/docs/e2ee.md), [`noPlaintextLeaves.test.js`](https://github.com/toldandretold/hyperlit/blob/main/tests/javascript/e2ee/noPlaintextLeaves.test.js))*

## Payments

Payments are handled by Stripe. Your card details never touch our servers. What we pass to Stripe is your numeric account id and the top-up amount — not your name, email, or address. We keep an append-only billing ledger of what you were charged and why, which you can export. *(code: [`StripeController.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/StripeController.php))*

## Publishing is your choice

Every book starts private. Making one public is an explicit, confirmed action. Public means public: readable by anyone, indexable by search engines, citable by other users, licensed under the book's content license. Highlights and citations you make on public books follow the visibility you give them. You can unpublish, though copies others made while it was public may persist in their libraries. *(code: [`PgLibrary.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Models/PgLibrary.php), [`publishing.php`](https://github.com/toldandretold/hyperlit/blob/main/config/publishing.php))*

## Export everything

You can download: any of your books as Markdown, Word, or EPUB
download the complete raw data bundle per book (content, highlights, citations, footnotes, original uploaded files); download audiobooks; and export whole shelves or your library as an archive. Your billing ledger is exportable too. *(code: [`downloads.ts`](https://github.com/toldandretold/hyperlit/blob/main/resources/js/components/sourceContainer/downloads.ts), [`app/Services/Export`](https://github.com/toldandretold/hyperlit/tree/main/app/Services/Export))*

## Delete your account

From your profile menu (Data → Delete account). You choose what happens to work you published: delete it entirely, keep it up anonymized, or keep it attributed. Private, unlisted, and encrypted books are always deleted, along with your private annotations, notifications, likes, shelves, and stored API tickets. Read-count records are anonymized (your name is removed; the anonymous counts remain). The billing ledger is retained as a financial record, held against a scrubbed account stub with no name, email, or password. Your username is permanently retired — nobody can register it after you. Deletion is immediate and irreversible; encrypted books are unrecoverable by anyone, including us. We confirm completion by email. *(code: [`UserAccountDeletionService.php`](https://github.com/toldandretold/hyperlit/blob/main/app/Services/UserAccountDeletionService.php), [`UserAccountDeletionServiceTest.php`](https://github.com/toldandretold/hyperlit/blob/main/tests/Feature/Account/UserAccountDeletionServiceTest.php))*

## Jurisdiction and contact

Hyperlit is operated from Australia and handles personal information in accordance with the Australian Privacy Principles. If you are in the EU/EEA, the practices above are how we meet GDPR obligations of access, portability, and erasure. Questions or requests: [GitHub issues](https://github.com/toldandretold/hyperlit/issues) or [sam@hyperlit.io](mailto:sam@hyperlit.io).

This policy describes the code as deployed, which is why each claim above links to the code that implements it — you are invited to check our work rather than take our word. The full source lives at [github.com/toldandretold/hyperlit](https://github.com/toldandretold/hyperlit), and the engineering version of this policy — every claim annotated with exact file-and-line citations — is in the repo at [docs/privacy-policy.md](https://github.com/toldandretold/hyperlit/blob/main/docs/privacy-policy.md).

# DPG application — draft answers per indicator

Draft answers for the Digital Public Goods Alliance nomination ([submission guide](https://www.digitalpublicgoods.net/submission-guide/), [standard](https://www.digitalpublicgoods.net/standard)). Start with their 5-minute eligibility test, then the nomination form; these are paste-ready first drafts — tighten to their field lengths. Status markers: ✅ ready, ⏳ needs an action first.

## 1. SDG relevance ✅

Hyperlit advances **SDG 4 (Quality Education)** and **SDG 16.10 (public access to information)**, with a supporting case for **SDG 10 (Reduced Inequalities)**.

Draft answer: Hyperlit is an open-source reading, writing and publishing platform for open-access research. It removes the two fees that gate scholarly participation — readers pay nothing to read and authors pay nothing to publish (the Diamond Open Access model UNESCO's Open Solutions programme promotes) — directly serving SDG 4's aim of equitable access to educational material and SDG 16.10's commitment to public access to information. Its two-way hyperlink citations let readers jump from any claim to the exact cited passage in the source and back, a verification affordance that strengthens the integrity of public knowledge. A built-in harvester imports entire diamond-OA journal corpora so under-resourced institutions get not just access to texts but access to advanced digital workflows over them (semantic search, AI-assisted citation review against open science databases) — addressing the inequality of research *tooling*, not only of texts (SDG 10). All content infrastructure is self-hostable under AGPL-3.0, so no institution's access depends on the operator.

## 2. Open licensing ✅

AGPL-3.0 (OSI-approved), declared in [LICENSE.md](https://github.com/toldandretold/hyperlit/blob/main/LICENSE.md) with a copyright header, and in the `composer.json` / `package.json` SPDX fields (`AGPL-3.0-only`). Evidence link: the LICENSE.md URL above.

## 3. Clear ownership ✅ (sub-items with lawyer)

Hyperlit is owned by **Lib Zen Pty Ltd**, an Australian company. Evidence: the copyright block atop [LICENSE.md](https://github.com/toldandretold/hyperlit/blob/main/LICENSE.md), the "License & ownership" section of the [README](https://github.com/toldandretold/hyperlit#license--ownership), and the operator identification on the public [privacy](https://hyperlit.io/privacy) and [terms](https://hyperlit.io/terms) pages. The Hyperlit name and logo are trademarks of Lib Zen Pty Ltd (stated in LICENSE.md). Internal follow-ups (do before submission if easy, else they don't block): founder IP assignment, logo-artwork assignment/credit from the designer, ABN filled into the public pages.

## 4. Platform independence ✅

Draft answer: the core platform — reading, writing, publishing, highlighting, two-way citations, import/export, search — runs entirely on open-source components (Laravel, PostgreSQL, Redis, Vite/TypeScript) with no mandatory closed dependency, and is self-hostable from the public repo. Optional paid features call external APIs, each with an open path: LLM features target any OpenAI-compatible endpoint (`LLM_BASE_URL`), use open-weight models (DeepSeek, Kimi, Gemma, gpt-oss), and can point at a self-hosted server; translation ships a local Ollama provider (the only mode permitted for encrypted books); text-to-speech uses the open-weights Kokoro-82M model, runnable locally; PDF OCR defaults to Mistral's API but a native on-device engine exists (`native_ocr`, Apple Vision) and open-source alternatives are planned. Payments (Stripe) exist only in the hosted deployment; a self-hosted instance runs fully without them. Evidence: `config/services.php` (every provider seam env-switchable), `docs/translation.md`, `docs/audio.md`.

## 5. Documentation ✅

Evidence links: the [README](https://github.com/toldandretold/hyperlit#readme) (features, full local-install walkthrough), the [docs/ directory](https://github.com/toldandretold/hyperlit/tree/main/docs) (deployment, billing, E2EE threat model, audio, translation, API conventions, scaling), `CLAUDE.md` (architectural invariants, each enforced by an automated test), and the generated data-flow map (`visualisation/generated/FLOWMAP.generated.md`) which is byte-checked in CI against the code it documents.

## 6. Mechanism for extracting data ✅

Draft answer: every user can self-serve export all non-PII data in non-proprietary formats: per-book Markdown, DOCX and EPUB; a complete raw JSON bundle per book (content, highlights, citations, footnotes, original uploaded files); whole-library or shelf archives as a Markdown vault (.zip) and a SQLite file including annotations and vector embeddings; audiobook files (.m4b); and the billing ledger. The export surfaces live in the reader's download panel and the account's Data sovereignty panel. JSON APIs serve the same data. Evidence: the [privacy page's export section](https://hyperlit.io/privacy) (which links the implementing code on GitHub), `app/Services/Export/`.

## 7. Privacy & applicable laws ⏳ publish /terms, fill ABN

Draft answer: the [privacy policy](https://hyperlit.io/privacy) states what is collected, every third-party processor and exactly when content reaches one, retention (identity-linked reading telemetry is de-identified after 90 days by an automated job), and user rights (full export; self-service account deletion with user choice over published work). Unusually, every claim in the policy links to the open-source code implementing it, so compliance is independently checkable. [Terms of service](https://hyperlit.io/terms) cover acceptable use and content rights. Operated by Lib Zen Pty Ltd (Australia) under the Australian Privacy Principles; GDPR access/portability/erasure obligations are met by the same mechanisms. Action before submitting: publish `docs/terms-page.md` as the `/terms` book and fill in the ABN on both pages.

## 8. Standards & best practices ✅

List for the form: HTML5/EPUB3/Markdown (CommonMark) content formats; DOI (Zenodo-minted, `CITATION.cff` in Citation File Format); ORCID for author identity; BibTeX export; OpenAlex and DOAJ integration for scholarly metadata; JSON-LD / Google Scholar meta tags; OAuth-less privacy-first design with WebAuthn passkeys (W3C) for E2EE; WCAG-oriented accessibility programme (axe-driven audit with a ratcheted violations baseline, focus-trap inventory enforced by test); OWASP-aligned practices (CSP headers, Postgres row-level security as defense in depth, sanitized write paths); SPDX license declarations; semantic versioning of releases.

## 9. Do no harm by design ⏳ depends on #7's publish step

a) PII: collected minimally (username, email, bcrypt password hash), protected by database-enforced row-level security so no user can read another's private data even through an application bug; optional end-to-end encryption (WebAuthn passkey, client-side keys) puts content beyond even operator access; identity-linked telemetry is de-identified after 90 days; full export and irreversible self-service deletion with username retirement against impersonation. b) Content: publishing is opt-in (private by default) and gated on a verified email; an internal flagging/moderation loop exists for operators, the [terms](https://hyperlit.io/terms) state the content rules, takedown contact is published (sam@hyperlit.io), and illegal content is removed on notice. c) User interaction: highlights/citations on public books are the interaction surface; the [CODE_OF_CONDUCT.md](https://github.com/toldandretold/hyperlit/blob/main/CODE_OF_CONDUCT.md) covers both repository and platform conduct, with a human-read reporting address and proportionate enforcement.

## Submission checklist

- Fill ABN into privacy + terms pages (and this repo's sources).
- Publish `/terms` as a book (same recipe as `/privacy`; strip the source note paragraph).
- Deploy the branch (Data sovereignty menu + deletion + telemetry rollup must be LIVE before the pages describing them are).
- Optional polish: designer's answer on the logo; founder IP assignment.
- Run the [eligibility test](https://www.digitalpublicgoods.net/eligibility), then submit the nomination with the answers above.

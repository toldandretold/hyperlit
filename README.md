![hyperlit](/public/images/titleLogo.png)

Read and self-publish hypertext literature. 

[https://hyperlit.io](https://hyperlit.io)

## [Why?](https://hyperlit.io/welcome)

I am a historian. I made this site to publish research with two-way hyperlink citations.[^1]

I import sources to read. I cite by copying passages and pasting them into my own article.

This means readers of my work can be taken directly to the cited passages in the source material.

You might want to use it for something else.

[Read more here](https://hyperlit.io/welcome)

## Features
### Free 
- **hypercites**: automatic, two-way hyperlink citations (Copy text with hypercite button. Paste it. Hypercited!)
- **hyperlights**: any-user can highlight any word
- **word .doc** import and export conversion (with dynamic footnotes and citations)
- **markdown .md** import and export conversion (with dynamic footnotes and citations)
- **automatic copy-paste conversion** of major academic journals (with dynamic footnotes and citations)

### Costs 
*These cost money for tokens, or compute. However, you are free to run this locally and use your own APIs or local LLMs though. Eventually might add feature to add your own API keys, but for now don't have any secure way of doing so.*

- **PDF conversion**: Mistral OCR converts PDF, and the resulting .json is converted to markdwon preserving academic referencing (being ironed out as I read more. Not perfect by any means. But once converted can easily download all raw files including markdown)
- **AI Archivist**: Select text to request archival research assistance. The selected text is turned into a vector embedding (numbers), and compared to vector embeddings of public text nodes in the hyperlit database. A small Qwen model is used to determine the scope of the vector search. For example: if user is just asking about the specific statement, might only draw vector comparisons on nodes in that book. But if user asks about a literature review of sources related to the content of the selected text, then vector comparison will be drawn on all nodes in the database. The results are sent to DeepSeek (hosted with no data capture on fireworks.ai). Because DeepSeek is prompted to use these known sources, it is able to respond with analysis that hypercites back to the original source material.
- **AI Citation Review**: a small open-weight LLM extracts citation data and truth claims for each in-text citation. Relevant data from the sources is vacuumed up via APIs to open access research metadata (OpenAlex, Open Library, Semantic Scholar, etc). Any pdfs available are fetched and converted with Mistral OCR. Then, text search is used to pull relevant text for each source, and this is sent to DeepSeek (hosted with no data capture on Fireworks.ai), which assesses the likelihood that each truth claim is supported by the source. A report is generated, and highlights are added to the reviewed text. An email is sent to notify when review is complete.

## How to use?

**login/register** via top left button on homepage.

**create new book or import from file**: top-right [+] button on homepage.

**hyperlight** any text by selecting text, and pressing the colored square.

**hypercite** any text by selecting text, pressing the hypercite button. Then: paste it.

**publish a book** by clicking the cloudRef button (top right in reader/writer mode) and clicking the red lock button. 

**read an academic journal within hyperlit.io** by copy and pasting it. Most major journals will have their footnotes and citations rendered dynamically by default. Even if this is not an open access text, you can still read and cite it yourself legally (just don't publish it). If it **is** open access, publish it so others can read along with you, and compare notes!

## License 

This is copyleft [free software](LICENSE.md).

Users have full sovereignty of their data. 

By default, published work comes with a copyleft inspired license that aims to protect text from being used to train non-free LLMs. See: [default license](https://hyperlit.io/license2025content). Ironically, the LLM slave that wrote this license tells me that it is unlikely to be legally binding.

## WARNING!

I created this website using LLMs. I have gradually gotten better at programming, but I am still largely dependent on LLMs. I'm sure both lovers and haters of vibez will find fucked shit in this code. 

It is for this reason that it is stronlgy advised that the website is **not used for any personal notes**, or anything that you would not want leaked to the internet. This is intended for publishing "copyleft" writing that you want others to read freely.

That said, I am a historian of global political economy who created this website in order to use it. I am using it to write and publish, and hope that -- eventually -- it will become reliable enough for others' trust. Now, though, it is clearly in need of "peer review".

## Built With

- Vanilla JavaScript (I know... I should update to Typescript)
- Laravel
- IndexedDB
- PostgreSQL
- Rangy highlighter
- Python

## Getting Started **locally**

### Prerequisites

You need the following installed on your system:
- **PHP 8.2+** ([download](https://www.php.net/downloads))
- **Composer** ([download](https://getcomposer.org/download/))
- **Node.js 18+** and npm ([download](https://nodejs.org/))
- **PostgreSQL** ([download](https://www.postgresql.org/download/))

### Installation

1. **Clone the repository**
   ```sh
   git clone https://github.com/toldandretold/hyperlit.git
   cd hyperlit
   ```

2. **Install PHP dependencies**
   ```sh
   composer install
   ```

3. **Install Node.js dependencies**
   ```sh
   npm install
   ```

4. **Set up environment variables**
   ```sh
   cp .env.example .env
   ```

   > *The `.env` file is your local configuration (automatically excluded from git via `.gitignore`). You'll need to update the database credentials in the next step.*

5. **Generate application key**
   ```sh
   php artisan key:generate
   ```

   > *This creates a unique encryption key in your `.env` file. No manual editing needed for this step.*

6. **Set up database (PostgreSQL required)**

   First, create a PostgreSQL database (using pgAdmin, psql, or your preferred tool).

   Then open `.env` and update these lines with your actual database credentials:
   ```
   DB_DATABASE=hyperlit          # or whatever you named your database
   DB_USERNAME=your_username     # your PostgreSQL username
   DB_PASSWORD=your_password     # your PostgreSQL password
   ```

   > *PostgreSQL is required (the project uses JSONB and other PostgreSQL-specific features). The other DB settings (host, port) are already correct for a standard local PostgreSQL install.*

7. **Run database migrations**
   ```sh
   php artisan migrate
   ```

8. **Set up local email (for password reset, etc.)**

   Install [Mailpit](https://github.com/axllent/mailpit) to catch outbound emails locally:
   ```sh
   brew install mailpit
   ```

   Then run `mailpit` in a separate terminal. The web UI is at http://localhost:8025. The `.env.example` is already configured to use it (SMTP on port 1025).

9. **Start the development servers**
   ```sh
   npm run dev:all
   ```

   This starts:
   - PHP server on http://localhost:8000
   - Queue worker
   - Vite dev server

   Visit http://localhost:8000 in your browser.

   **For mobile testing:** Use `npm run dev:network` instead. This makes the server accessible on your local network (e.g., http://192.168.1.x:8000) so you can test on phones/tablets.

### Alternative: Run servers separately

If you need more control:

```sh
# Terminal 1: PHP server
php artisan serve

# Terminal 2: Queue worker
php artisan queue:work

# Terminal 3: Vite dev server
npm run dev
```

### Commands useful for humans and LLMs

**View database schema:**
```sh
php artisan schema:dump
```
This creates a readable SQL schema file at `database/schema/pgsql-schema.sql` - useful for understanding the database structure without reading individual migration files. Both biological and artificial intelligence benefit from this.

**View application logs:**
Laravel logs are saved to `storage/logs/laravel.log` - check here for errors and debugging information.

**Other helpful commands:**
```sh
php artisan migrate:fresh    # Reset database and re-run all migrations
php artisan route:list       # View all registered routes
php artisan tinker           # Interactive PHP REPL with your app loaded
```

## Architectural Overview

### Canonical Sources & Versions

Hyperlit separates the **citation identity of a work** (one row in `canonical_source`) from each **uploaded version** of it (one row in `library`). Multiple uploads of the same work — an author's PDF, a community-OCR'd copy, an OpenAlex stub — can share a single canonical. Verification signals stack on the canonical (`openalex_id`, `open_library_key`, `semantic_scholar_id`, `verified_by_publisher`, `commons_endorsements`), and each version carries its own provenance (`conversion_method`, `human_reviewed_at`, `is_publisher_uploaded`) plus a pair of scores against the canonical — one for identity confidence, one for metadata quality — so sloppy library rows are distinguishable from clean ones even when the DOI matches.

Full breakdown: [`docs/canonical-sources.md`](docs/canonical-sources.md).

### Hypertext Loading 
Each Hypertext 'book' is stored as html parent-nodes (paragraph, heading, table, blockquote, etc), in the content column of the nodes table in PostgreSQL.

Each node is a row, with its own nodeID. This is used to match each node to any hyperlights or hypercites a user has attached. These are stored in seperate hypercites and hyperlights tables in postgreSQL.

When a user navigates to hyperlit.io/book, the nodes for that book are pulled from the nodes table, along with its "library card" details from the library table, and any other related content from the hyperlights, hypercites, bibliography, or footnotes tables (relying on nodeID). 

In /app/Http/Controllers/DatabaseToIndexedDBController this content is pulled and sorted. For example, it is authorised according to users' current credentials, and preferred gatekeeping. Then, it is sent to the front end as .json. 

The backend also checks which chunk needs to be loaded first, and sends only that chunk. This ensures text can be read quickly. Other chunks are loaded into indexedDB afterp page load. See: /resources/js/initialChunkLoader.js ... Note: Edit mode will not work until all other chunks have downloaded.

On the frontend:

1. **intializePage.js** uses **syncBookDataFromDatabase(bookId)** from **postgreSQL.js** to pull the json from backend, and store it in the browser's indexedDB.

2. The character position data from each hyperlight and hypercite are pulled from their respective object stores in indexedDB and put into an array within the nodes object store. This allows for the mark (highlight) tags and underline (hypercite) tags to be loaded more seamlessly into the DOM.

3. The nodes for the **book**, and any related hypercites, hyperlights, footnotes or citations, are injected into the ```<main>``` within the DOM using lazyLoaderFactory.js

```<main class="main-content" id="**book**">```


4. It is "lazy loaded", in the sense that one "chunk" of 100 nodes is inserted into the DOM at a time. As user scrolls past ```<div class="sentinenel">```, new chunks of nodes are inserted either above or below. 

This ensures that the site is responsive and usable, even when reading a massive academic book filled with footnotes and hypercites 

### Hyperlight and Hypercite **Data Flow**

Hypercites and Hyperlights are stored in hyperlights and hypercites data tables in PostgreSQL as the centralised source of truth. They are related to their respective hypertext nodes via the node_id column.

#### From postgreSQL to indexedDB
1. **Gatekeeping**: Because they are stored as seperate rows of data, the *databaseToIndexedDBController* can effectively sort them according to users' "gatekeeping" preferences, before sending them to the front end.

2. **pre-hyrdation**: After sorting, the charData (character data), is inserted into the json for each node. This means that the front end receives each hypertext node along with all relevant character-start and character-end data for any hypercite or hyperlight that it needs to render into the DOM with mark and u tags.

#### From indexedDB to DOM
1. When creating a hypercite or hyperlight, the front-end updates the indexedDB object stores of 'hypercites' or 'hyperlights'. 

2. It then updates the nodes object store to have the latest charData in nodes.hyperlights and nodes.hypercites. 

3. It then uses this to update hyperlights and hypercites for the effected nodes currently in the DOM.

### From indxedDB to PostgresQL
**Important**: no nodes.hyperlights nor nodes.hypercites are sent to backend, as there is no nodes.hyperlights or nodes.hypercites columns in postgreSQL. This is because users only update their own rows in the hypercites and hyperlights tables. The "hydration" of charData into nodes.hyperlights and nodes.hypercites is done purely for each user's own indexedDB nodes object store. This is because:

1. each user will have their own custom hyperlit gatekeeping. 
2. we don't want users editing the nodes data table of another user's book. (hyperlights and hypercites are treated as the sovereign data of their users, and not tied to the sovereign data of other users, except via the relation of node_id)
3. this also enables us to have a ghost hypercite system, which [is done](https://hyperlit.io/book_1776498326506).

## Tests

### Regression Tests

End-to-end tests use [Playwright](https://playwright.dev/) to drive a real browser against a running local instance of Hyperlit.

#### Prerequisites

- Local dev server running (`npm run dev:all`)
- A test user account (the auth setup project in the Playwright config handles login via `.auth-state.json`)

#### Running Tests

Run all E2E tests:
```sh
npx playwright test --config tests/e2e/playwright.config.js
```

Run a specific test file:
```sh
npx playwright test tests/e2e/specs/workflows/authoring-workflow.spec.js --config tests/e2e/playwright.config.js
```

Watch the tests run in a visible browser (useful for debugging and demos):
```sh
npx playwright test tests/e2e/specs/workflows/authoring-workflow.spec.js --headed --config tests/e2e/playwright.config.js
```

#### What the Tests Cover

Full per-spec breakdown lives in [`tests/e2e/README.md`](tests/e2e/README.md). Bird's-eye view:

**Smoke** (`tests/e2e/specs/smoke/`) — fast sanity check. Cold-load home / reader / user, assert correct `data-page`, `buttonRegistry` healthy, no console errors. First thing to run when something feels broken.

**SPA Transitions** (`tests/e2e/specs/transitions/`) — every cross-template SPA navigation path (home↔reader, reader↔reader, home↔user, reader↔user, etc.). Each test clicks the realistic UI affordance (logo, book card, hypercite, "My Books"), waits for the transition, and asserts the destination structure + registry health.

**Regression Tests** (`tests/e2e/specs/regression/`) — guards against bug classes that have bitten before:
- `globals-after-spa.spec.js`: page-scoped globals (`window.isUserPage`, etc.) reflect the *current* page after SPA navigation, not the page we came from.
- `listener-accumulation.spec.js`: `document` event listeners stay stable across home→reader→home cycles (cleanup-leak detection).
- `registry-after-spa.spec.js`: `buttonRegistry` has exactly the components the new page needs — no leftovers, no missing entries.
- `toc-deep-nav.spec.js`: TOC entries scroll their target heading into viewport, don't open hyperlit containers as a side-effect, and the TOC closes after each click.

**Workflows** (`tests/e2e/specs/workflows/`) — multi-phase user journeys end-to-end:
- `authoring-workflow.spec.js`: the flagship test — create book 1, type & format, create hyperlight + hypercite, navigate home, create book 2, paste hypercite, follow the citation back to book 1 via "See in source text", browser back/forward.
- `file-import-drag-drop.spec.js`: drop a `.md` on home → import form auto-opens → submit → SPA-transition to the imported book → edit → exit edit mode (integrity verifier) → navigate home → drop target re-initializes cleanly. Plus negative cases for drop suppression when the form is already open and on reader pages.
- `spa-grand-tour.spec.js`: catch-all 8-phase SPA correctness test — every transition path, three-lap state-accumulation runs, back/forward replay, post-authoring tour to confirm authoring didn't poison subsequent SPA cycles.
- `nested-authoring-stress.spec.js`: build a 4-level nest (footnote → hyperlight → footnote → hyperlight), typing a known phrase at each level with a tight wait that races the debounced write against save-on-close. Navigate away and back, re-open every level, verify every phrase round-tripped through DOM → IndexedDB → Postgres.
- `nested-hypercite-chain.spec.js`: two tests. (1) Build a 3-deep nest, copy hypercites from each level, paste at the level above so every level cites the level below. Verify the chain via clicks and the popstate cycle. (2) Cross-book back-restore — regression guard for the "press back from another book and the deep stack collapses" bug. Builds depth-3 stack in book A, navigates home → book B → pastes a hypercite → clicks it back to A → walks back through history. Strict assertions at the cross-book popstate boundary (state preserved, not nulled) and at the cs=3 entry (all 3 layers restored, all 4 typed phrases visible).
- `cross-book-hypercite-tour.spec.js`: "nightmare scenario" stress — imports real long books (rockhill.epub), creates a hypercite mid-book post-lazy-load in Book A, pastes it on a deep paragraph in B reached via TOC. Then loops: TOC nav → footnote-stress → click hypercite → SPA back → rapid back/forward bursts. A restoration spy logs every hyperlit-container lifecycle event; on test end three forensic artifacts (timeline.json, summary, anomalies) are attached for diagnosis.
- `cross-book-navigation-stress.spec.js`: chaos test guarding against cross-book container leaks. Builds two books with stacks, runs a fixed 30-step sequence of mixed back/forward/SPA-nav/hypercite-click actions, and at every step asserts no orphan `.hyperlit-container-stacked` zombies remain and visible-container-count matches saved history-stack-depth. Caught the 2026-05-16 "stacked container from book B's citation panel persists into book A after SPA nav" bug at step 20 (fixed by a defensive DOM sweep after stack unwind in `hyperlitContainer/core.js`).

**Editor** (`tests/e2e/specs/divEditor/`) — `id-collision.spec.js` pins the 2026-05-12 incident where `generateIdBetween` could mint a duplicate node ID and trip the integrity verifier.

#### Still not covered
- Frontend assertions only — the tests verify the DOM and IndexedDB reflect the right state, but do not currently SELECT from Postgres after a write to confirm it really landed. Adding post-test SQL queries would close this loop.
- No backend test coverage. No API/route auth tests (e.g. that authenticated routes reject anonymous requests, that user A can't write to user B's data).
- No mobile-touch event coverage (long-press, swipe gestures on the reader / containers).


## Roadmap

1. Hyperlight-ghost system (user can still see their own highlights in text, if original nodes were removed by crreator).
2. See all hyperlights of one book in a seperate book, with links back to in-text hyperlights.
3. Pre-inject first chunk for faster load time and SEO.
4. More security vulnerability testing. 


## Contributing

Please use it. Let me know what you use it for. Ask for help. Let me know what sucks.

## Origin and Motivation
I thought of the underdevelopment of academic software, and software in general, while a history student at the University of Adelaide. Deep within the library, I would chuckle at the grafiti left inside books. What did a student reading the same book decades earlier have to say? I was struck by a realisation: library books are the original "social media". When a knowledge community shares a single copy of a text, they can leave messages in the margins. What's insane about this is that -- in theory -- the internet should have massively augmented this already-existing social reading experience. Hypertext was primed to provide a form of reading that was highly customisable, and highly social. So what went wrong?

Actually, the internet *did* drastically improve the reading and writing experience for many different knowledge communities. Consider that:

- Linux used email to create a [more secure operating system](https://www.gnu.org/software/fsfe/projects/ms-vs-eu/halloween1.html) than the then monopoly, Microsoft. 
- Tim Berners-Lee first envisoned HTTP and HTML as the basis of [a better knowledge system](https://hyperlit.io/book_1762834024918) for CERN.
- The open-source software of Wikipedia has sustained a communist node of knowledge production.[^2]
- Long before the internet, in the 1960s, people created hypertext editors that [allowed for a far more precise form of hypertext citations](https://dhq.digitalhumanities.org/vol/4/1/000081/000081.html). People could link back to specific parts of a text. This allowed for proto-docuverses, where a text could link directly to the cited portions of sources.

So the question in need of asnwering isn't 'why hasn't the internet augmented social reading and writing', it is: 'why has academic publishing been so severely *underdeveloped*?' The answer, surprise surprise, is monopoly capitalism. Unfortunately for the monopoly publishers of academic knowledge, their own dominance is dwarfed by big tech. This inter-capitalist crisis of knowledge production is scary. Knowledge workers should support copyleft software that supports personal data sovereignty. 

## Contact

[fml@hyperlit.io](mailto:fml@hyperlit.io)

[GitHub issues](https://github.com/toldandretold/hyperlit/issues) or [@toldandretold](https://github.com/toldandretold)

Leave a hyperlight in [my hypertext library](https://hyperlit.io/u/toldandretold)



## Notes
[^1]: two-way hyperlinks was a core idea of Ted Nelson's ideas for a Docuverse. Linking directly to the cited text was a feature of the original hypertext editors. See: Belinda Barnet, ["Crafting the User-Centered Document Interface: The Hypertext Editing System (HES) and the File Retrieval and Editing System (FRESS)"](https://hyperlit.io/craftingtheuser)

[^2]: Knowledge is freely given according to ones abilities, and freely enjoyed according to ones needs.


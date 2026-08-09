# Queue worker topology (Supervisor)

> **Deploying new code? You want `../README.md` — the deploy is one command: `./deploy/deploy.sh` (or `hd` from your laptop). It restarts these workers for you.** This file is the *reference*: which job runs where, how to poke a worker by hand, and what the box can afford to run at once.

Production `hyperlit.io` runs queue workers under Supervisor (`/etc/supervisor/conf.d/`). `QUEUE_CONNECTION=database`. Each Supervisor *program* is an independent set of worker processes; **a worker serves its `--queue` list serially, one job at a time.** Separate queues + separate programs = real parallelism between job classes.

**Rule: every job class gets its own worker.** Document conversion must never wait behind any other job — a shared serial worker head-of-line-blocks, no matter how the priorities are ordered. We learned this twice: vibe (28-min Python runs) blocked imports until it got `hyperlit-vibe`; then citation pipelines (12–15 min of LLM calls, and they *outranked* `default`) did exactly the same until they got `hyperlit-citation`.

## Poking workers by hand

`workers.sh` wraps the chores so you never have to remember the six program names. Run it on the droplet after `cd /var/www/hyperlit`, or from your laptop via the `hw` alias (defined in `../README.md`):

```bash
hw status              # are all 6 workers RUNNING?
hw restart             # graceful: finish current job, reload new code (what deploy.sh does)
hw restart citation    # hard-restart ONE program (worker|citation|vibe|audio|embeddings|search)
hw logs citation -f    # tail a worker's log (-f follows)
hw health              # queue:probe + citation:doctor --fast
hw backlog             # what's queued/reserved per queue + failed count
hw force-restart       # hard SIGTERM all — can WAIT on an in-flight job, avoid
```

`restart` with no name runs `php artisan queue:restart`: each worker finishes its current job, exits, and Supervisor relaunches it on the new code. A `force-restart` / `supervisorctl restart` SIGTERMs immediately and then **waits up to the job's `stopwaitsecs`** — ≈2 h for a mid-run citation job — before the process actually cycles.

## The queues

### `default` → worker `hyperlit-worker`

- Jobs: `ProcessDocumentImportJob` (imports/reconverts) **plus every job with no `onQueue()`** (see notes below).
- The user-facing baseline; `numprocs` is the concurrency lever (RAM-gated, see conf).

### `citation-pipeline` → worker `hyperlit-citation`

- Jobs: `CitationPipelineJob`, `CitationScanBibliographyJob`, `CanonicalizeLibraryJob`.
- 12–15+ min LLM/web runs; used to share (and outrank!) `default`.

### `vibe` → worker `hyperlit-vibe`

- Job: `VibeConversionJob`.
- Up to ~28 min Python.

### `audio` → worker `hyperlit-audio`

- Job: `GenerateBookAudioJob` (per-node TTS audiobook generation, docs/audio.md).
- Minutes of batched TTS-API calls per book (job `$timeout` 3600s); resumable + charge-after-success, so interrupting it loses nothing but the in-flight batch. Needs `TTS_API_KEY` in the droplet `.env`.

### `embeddings` → worker `hyperlit-embeddings`

- Job: `GenerateNodeEmbedding`.
- High-volume short jobs; used to ride on `hyperlit-worker`'s queue list, halving import capacity during drains.

### `search-supplement` → worker `hyperlit-search`

- Job: `IngestExternalCitationCandidatesJob` (OpenAlex/Open Library fetch when a citation search returns thin local results).
- Seconds-long and the ONLY queue a user actively waits on in real time — the citation modal polls for ~8s after dispatch. On `default` it queued behind 15-min imports, so the polls always missed. Lightest class in the budget (< embeddings' 50 MB peak); `--sleep=1` for snappy pickup.

### Topology notes & invariants

> **`default` carries more than imports.** Any `ShouldQueue` job that does *not* call `onQueue(...)` lands on `default` and is served by `hyperlit-worker` alongside imports: `QueueBookEmbeddings` (the fan-out that dispatches the per-node `embeddings` jobs), `PandocConversionJob` (DOCX path), `WarmBookCacheJob`, and the scheduled `DatabaseCleanupJob` / `DailyStatsJob` / `UpdateLibraryStatsJob` / `UpdateHomepageJob`. They're light or scheduled, so they don't warrant their own worker — but they *do* share the import worker's single serial head, which matters when reasoning about blocking.
>
> **`$tries` precedence.** A job's `public $tries` property *overrides* the worker's `--tries` flag. So actual retries follow the job, not the conf: `CitationPipelineJob` / `CanonicalizeLibraryJob` / `GenerateNodeEmbedding` retry **3×** (despite `--tries=1`/`2`), while `ProcessDocumentImportJob` and `VibeConversionJob` stay at **1** (never auto-retry).
>
> ⚠️ Two invariants when touching this topology:
> 1. **Nothing listens on a queue → its jobs silently never run.** An app change that adds/renames an `onQueue()` and the worker conf MUST ship together. `deploy.sh` warns when a `.conf` changed and offers to install it.
> 2. **`retry_after` (config/queue.php, now 7500s) must exceed the longest job `$timeout` (CitationPipelineJob: 7200s).** At Laravel's 90s default, any job running longer is re-reserved by a parallel worker and runs twice (historical `MaxAttemptsExceededException` failures on imports were this).

## Installing / renaming a worker program

> Only when you ADD or RENAME a worker. Routine deploys are `./deploy/deploy.sh`, which offers to do this for you when it sees a changed `.conf`.

```bash
sudo cp deploy/supervisor/hyperlit-*.conf /etc/supervisor/conf.d/
sudo supervisorctl reread
sudo supervisorctl update                  # starts new programs, reloads changed ones
sudo supervisorctl status                  # confirm all programs RUNNING
php artisan queue:restart                  # running workers pick up new code
php artisan citation:doctor                # preflight: node/playwright/chromium, python OCR
                                           # deps, LIVE LLM role models, OCR/search APIs,
                                           # and an end-to-end citation-queue probe
```

## Local dev

`npm run dev:all` / `dev:network` mirror this topology with a dedicated worker per queue: **IMP1+IMP2** (`queue:import` — two import workers, so concurrent-import testing works locally), **CITE** (`queue:citation`), **VIBE** (`queue:vibe`), **AUD** (`queue:audio`), **EMBED** (`queue:embeddings`), **SRCH** (`queue:search`). `php artisan work` remains as a single catch-all for one-off manual shells only — it is serial and reintroduces the blocking.

## The RAM budget (measured) — and why more concurrency means more RAM

Every Supervisor program is a real OS process holding real memory while its job runs. Concurrency is therefore bought with RAM: **each extra simultaneous job of class X costs that class's peak RSS, every time, on top of everything else.** The queue topology decides *what can overlap*; the RAM budget decides *what the box survives when it does*.

Peaks measured 2026-06-12 with real jobs (`tests/load/memprobe.sh`; full method + caveats in `tests/load/README.md`):

- **import (`default`) — 212 MB.** PHP worker + Python conversion (700-page handbook → 9.7k nodes).
- **citation pipeline — 200 MB.** PHP doing batched LLM review + claim verify (230 refs).
- **vibe conversion — 182 MB.** PHP worker + Python sandbox re-conversion + gate.
- **embeddings — 50 MB.** PHP worker, small HTTP calls.
- **search-supplement — ~50 MB (estimated).** PHP worker, OpenAlex + Open Library fetch; same profile as embeddings (two HTTP fetches + small upserts) — re-measure with memprobe when convenient.
- **audio (TTS) — ~50 MB (estimated).** PHP worker, DeepInfra TTS calls + file writes; embeddings profile with a 5-wide `Http::pool` of ~150 KB base64 audio responses — re-measure with memprobe when convenient.
- **All six truly simultaneous — ~620 MB observed-basis, ~745 MB worst-case sum.**

(Citation was measured with `--skip-fetch`. A live vacuum phase launches headless chromium per fetch — ~150–300 MB transient on top of the citation worker — so worst case during vacuum trends toward ~900 MB. Check `free -m` during the first real run after installing chromium.)

The arithmetic for this droplet (~1.9 GB physical + 2 GB swap, OOM history):

```
baseline (nginx + PHP-FPM + Postgres + idle workers)   ~700–1000 MB  ← read it: ssh marx@… 'free -m'
max overlap, current topology (numprocs=1 everywhere)   ~745 MB
                                                        ─────────────
                                                        ~1.4–1.7 GB of 1.9 GB
```

**Fits — that's why shipping one-worker-per-class is safe on current hardware.**

Raising any `numprocs` re-runs this math. `numprocs=2` on imports adds another 212 MB *at peak*, pushing worst case to the edge of physical RAM — and past it if the baseline sits at the high end. Falling into swap means every import crawls; OOM means the kernel kills PHP-FPM and *everyone* gets Cloudflare 502s. That's the whole "more concurrency requires more RAM" rule: the topology change was free because it only reorganised existing workers; **capacity** (N simultaneous users *per feature*) is the thing you buy with hardware.

**Adding a resident service (GROBID, FlareSolverr, …)?** Its RSS joins this budget exactly like a worker class — but resident JVMs never give memory back, so they raise the BASELINE, not the overlap. `deploy/grobid.md` walks the math for GROBID specifically (verdict: ~0.5–1 GB resident does NOT fit this box; resize first, or host it on a side droplet — the app falls back to regex either way).

Order of operations when multi-user import demand is real:
1. Resize the droplet (4 GB roughly doubles the job budget).
2. THEN `numprocs=2` on `hyperlit-worker` (+212 MB worst case).
3. Re-measure with `memprobe.sh` ON the box during real runs; raise further only while peak usage stays comfortably inside physical RAM (swap is a crash pad, not capacity).
4. Unmeasured tail to test on a clone droplet before trusting big scanned PDFs: a live Mistral OCR fetch (no cached `ocr_response.json`) holds base64 page JSON in Python and can spike well past 212 MB.

Empirical probes: `tests/load/loadprobe.php` (HTTP concurrency), `php artisan queue:probe` (worker topology), `tests/load/memprobe.sh` (RAM peaks). For queue-level spot checks: dispatch two imports and confirm both workers hold one — `SELECT queue, reserved_at FROM jobs` shows who's got what.

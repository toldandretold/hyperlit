# Queue worker topology (Supervisor)

Production `hyperlit.io` runs queue workers under Supervisor (`/etc/supervisor/conf.d/`).
`QUEUE_CONNECTION=database`. Each Supervisor *program* is an independent set of worker
processes; **a worker serves its `--queue` list serially, one job at a time.** Separate
queues + separate programs = real parallelism between job classes.

**Rule: every job class gets its own worker.** Document conversion must never wait
behind any other job — a shared serial worker head-of-line-blocks, no matter how the
priorities are ordered. We learned this twice: vibe (28-min Python runs) blocked
imports until it got `hyperlit-vibe`; then citation pipelines (12–15 min of LLM calls,
and they *outranked* `default`) did exactly the same until they got `hyperlit-citation`.

## The queues

| Queue              | Jobs                                              | Worker               | Notes |
|--------------------|---------------------------------------------------|----------------------|-------|
| `default`          | `ProcessDocumentImportJob` (imports/reconverts)   | `hyperlit-worker`    | the user-facing baseline; `numprocs` is the concurrency lever (RAM-gated, see conf) |
| `citation-pipeline`| `CitationPipelineJob`, `CitationScanBibliographyJob`, `CanonicalizeLibraryJob` | `hyperlit-citation`  | 12–15+ min LLM/web runs; used to share (and outrank!) default |
| `vibe`             | `VibeConversionJob`                               | `hyperlit-vibe`      | up to ~28 min Python |
| `embeddings`       | `GenerateNodeEmbedding`                           | `hyperlit-embeddings` | high-volume short jobs; used to ride on hyperlit-worker's queue list, halving import capacity during drains |

> ⚠️ Two invariants when touching this topology:
> 1. **Nothing listens on a queue → its jobs silently never run.** An app change
>    that adds/renames an `onQueue()` and the worker conf MUST ship together.
> 2. **`retry_after` (config/queue.php, now 7500s) must exceed the longest job
>    `$timeout` (CitationPipelineJob: 7200s).** At Laravel's 90s default, any job
>    running longer is re-reserved by a parallel worker and runs twice
>    (historical `MaxAttemptsExceededException` failures on imports were this).

## Install / update on the droplet

```bash
ssh marx@170.64.145.89
cd /var/www/hyperlit && git pull           # picks up confs + retry_after bump

sudo cp deploy/supervisor/hyperlit-worker.conf     /etc/supervisor/conf.d/
sudo cp deploy/supervisor/hyperlit-citation.conf   /etc/supervisor/conf.d/
sudo cp deploy/supervisor/hyperlit-vibe.conf       /etc/supervisor/conf.d/
sudo cp deploy/supervisor/hyperlit-embeddings.conf /etc/supervisor/conf.d/
sudo supervisorctl reread
sudo supervisorctl update                  # starts hyperlit-citation, reloads worker
sudo supervisorctl status                  # confirm all programs RUNNING

php artisan queue:restart                  # tell running workers to pick up new code

php artisan citation:doctor                # preflight: node/playwright/chromium, python OCR
                                           # deps, LIVE LLM role models, OCR/search APIs,
                                           # and an end-to-end citation-queue probe
```

Check the droplet's `.env` does NOT set `DB_QUEUE_RETRY_AFTER` (it would override
the 7500s config default).

## Local dev

`npm run dev:all` / `dev:network` mirror this topology with a dedicated worker per
queue: **IMP1+IMP2** (`queue:import` — two import workers, so concurrent-import
testing works locally), **CITE** (`queue:citation`), **VIBE** (`queue:vibe`),
**EMBED** (`queue:embeddings`). `php artisan work` remains as a single catch-all
for one-off manual shells only — it is serial and reintroduces the blocking.

## The RAM budget (measured) — and why more concurrency means more RAM

Every Supervisor program is a real OS process holding real memory while its job
runs. Concurrency is therefore bought with RAM: **each extra simultaneous job of
class X costs that class's peak RSS, every time, on top of everything else.**
The queue topology decides *what can overlap*; the RAM budget decides *what the
box survives when it does*.

Peaks measured 2026-06-12 with real jobs (`tests/load/memprobe.sh`; full method
+ caveats in `tests/load/README.md`):

| Job class | Peak RSS | What's in the tree |
|---|---|---|
| import (`default`) | **212 MB** | PHP worker + Python conversion (700-page handbook → 9.7k nodes) |
| citation pipeline | **200 MB** | PHP doing batched LLM review + claim verify (230 refs) |
| vibe conversion | **182 MB** | PHP worker + Python sandbox re-conversion + gate |
| embeddings | **50 MB** | PHP worker, small HTTP calls |
| **all four truly simultaneous** | **521 MB** observed / **~645 MB** worst-case sum | |

(Citation was measured with `--skip-fetch`. A live vacuum phase launches headless
chromium per fetch — ~150–300 MB transient on top of the citation worker — so
worst case during vacuum trends toward ~900 MB. Check `free -m` during the first
real run after installing chromium.)

The arithmetic for this droplet (~1.9 GB physical + 2 GB swap, OOM history):

```
baseline (nginx + PHP-FPM + Postgres + idle workers)   ~700–1000 MB  ← read it: ssh marx@… 'free -m'
max overlap, current topology (numprocs=1 everywhere)   ~645 MB
                                                        ─────────────
                                                        ~1.35–1.65 GB of 1.9 GB
```

**Fits — that's why shipping one-worker-per-class is safe on current hardware.**

Raising any `numprocs` re-runs this math. `numprocs=2` on imports adds another
212 MB *at peak*, pushing worst case to the edge of physical RAM — and past it
if the baseline sits at the high end. Falling into swap means every import
crawls; OOM means the kernel kills PHP-FPM and *everyone* gets Cloudflare 502s.
That's the whole "more concurrency requires more RAM" rule: the topology change
was free because it only reorganised existing workers; **capacity** (N
simultaneous users *per feature*) is the thing you buy with hardware.

Order of operations when multi-user import demand is real:
1. Resize the droplet (4 GB roughly doubles the job budget).
2. THEN `numprocs=2` on `hyperlit-worker` (+212 MB worst case).
3. Re-measure with `memprobe.sh` ON the box during real runs; raise further only
   while peak usage stays comfortably inside physical RAM (swap is a crash pad,
   not capacity).
4. Unmeasured tail to test on a clone droplet before trusting big scanned PDFs:
   a live Mistral OCR fetch (no cached `ocr_response.json`) holds base64 page
   JSON in Python and can spike well past 212 MB.

Empirical probes: `tests/load/loadprobe.php` (HTTP concurrency),
`php artisan queue:probe` (worker topology), `tests/load/memprobe.sh` (RAM
peaks). For queue-level spot checks: dispatch two imports and confirm both
workers hold one — `SELECT queue, reserved_at FROM jobs` shows who's got what.

# Queue worker topology (Supervisor)

Production `hyperlit.io` runs queue workers under Supervisor (`/etc/supervisor/conf.d/`).
`QUEUE_CONNECTION=database`. Each Supervisor *program* is an independent set of worker
processes; **a worker serves its `--queue` list serially, one job at a time.** Separate
queues + separate programs = real parallelism between job classes.

## The queues

| Queue              | Jobs                                          | Worker                  | Why separate |
|--------------------|-----------------------------------------------|-------------------------|--------------|
| `default`          | `ProcessDocumentImportJob` (imports/reconverts) | `hyperlit-worker`       | the baseline |
| `citation-pipeline`| Citation scan / canonicalize jobs             | `hyperlit-worker` (or `hyperlit-citation`) | heavy, decoupled from imports |
| `embeddings`       | `GenerateNodeEmbedding`                        | (existing)              | "stop embeddings clogging the queue" |
| **`vibe`**         | **`VibeConversionJob`**                        | **`hyperlit-vibe`** (NEW) | runs ~28 min — must never block imports |

### Why `vibe` got its own worker (the fix in this change)

A vibe conversion shells out to Python for up to ~28 min (`VibeConversionJob` Process
timeout = 1700s). It was on `default`, served by the single serial `hyperlit-worker`,
so **one vibe run head-of-line-blocked every user's import for up to half an hour** —
worse with multiple users (one person's vibe stalls everyone's imports). `VibeConversionJob`
now dispatches to `onQueue('vibe')` and `hyperlit-vibe.conf` gives it a dedicated parallel
worker. This mirrors how embeddings and the citation pipeline were already split off.

> ⚠️ The app change (`onQueue('vibe')`) and the worker MUST ship together. If nothing
> listens on `vibe`, vibe conversions queue forever and silently never run.

## Install / update on the droplet

```bash
ssh marx@170.64.145.89
cd /var/www/hyperlit && git pull           # picks up onQueue('vibe') + these confs

sudo cp deploy/supervisor/hyperlit-vibe.conf /etc/supervisor/conf.d/
sudo supervisorctl reread
sudo supervisorctl update                  # starts hyperlit-vibe
sudo supervisorctl status                  # confirm hyperlit-vibe RUNNING

php artisan queue:restart                  # tell running workers to pick up new code
```

If you change `hyperlit-worker.conf` too, `sudo cp` it as well, then `reread && update`.

## Local dev

`npm run dev:all` now starts a **VIBE** process (`npm run queue:vibe` =
`queue:work --queue=vibe`) alongside the main **QUEUE** worker, so vibe conversions work
locally. To run just the vibe worker: `npm run queue:vibe`.

## Import concurrency (the second concern)

Even with vibe gone, `default` is still **one serial worker** — two users importing at the
same time serialize (the second waits). The lever is `numprocs=N` in `hyperlit-worker.conf`
(N concurrent imports).

**Don't raise it yet on this box.** ~1.9 GB RAM + 2 GB swap with OOM history; an import
runs pandoc + Python (+ Mistral OCR) and spikes to hundreds of MB. Two concurrent imports
+ the vibe worker + PHP-FPM can OOM (→ Cloudflare 502). Order of operations if concurrent
imports become a real bottleneck:

1. Vertically scale the droplet RAM first.
2. Then set `numprocs=2` on `hyperlit-worker`.
3. `--max-jobs` (already set) recycles workers so leaked memory can't accumulate.

The big win here is vibe no longer blocking imports — not more import workers.

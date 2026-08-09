# GROBID on prod — server-load review + install steps

> **DECISION (2026-08-08): don't host GROBID yet — but the integration is now the SURGICAL MERGE, which the trial showed is strictly-positive (adds hidden entries from glued reference blobs, provably never removes anything regex found).** Hosting is pure upside whenever it happens; the natural moment is the already-planned droplet resize. Full experiment record and per-book numbers: **`deploy/experiments/grobid.md`**. This file is the install/ops runbook for that day; nothing below needs doing today.

GROBID is the ML reference-segmenter behind the bibliography stage's **escalation path** (`app/Python/digestion/bibliographyExtraction/grobid_client.py`, wired in `bib_passes.py:ExtractBibliography`). The code is already shipped and is a no-op until you finish this doc: a book only escalates when its regex-scanned bibliography is *suspect* (run-on entries carrying multiple "(year)" patterns, or merged over-long blobs — the pathologies the regex splitter cannot fix, e.g. book `93d34a74`'s "Al-Awqati (2007) doi:… Archambault (2009)…" chains), AND `GROBID_URL` is set, AND the book's source PDF is on disk. Every failure mode — env unset, server absent (5s probe), server hung (120s/request + 300s/document budget), thin result — falls back to the regex path unchanged. So nothing here is urgent and nothing here can break conversion: an unreachable GROBID is byte-identical to no GROBID.

## 1. The server-load review (do the math before installing ANYTHING)

The droplet runs a **measured RAM budget** (`deploy/supervisor/README.md`, probes in `tests/load/memprobe.sh`): ~1.9 GB physical + 2 GB swap, OOM history where the kernel killed PHP-FPM and the whole site 502'd. The standing numbers:

- baseline (nginx + PHP-FPM + Postgres + idle workers) — **~700–1000 MB** (confirm live: `ssh marx@170.64.145.89 'free -m'`).
- worst-case simultaneous jobs, current topology — **~745 MB**, trending to **~900 MB** during a citation vacuum phase (headless chromium).
- current total: ~1.4–1.9 GB of 1.9 GB. It fits, barely, and that "barely" is why every `numprocs` stays at 1.

GROBID (lightweight CRF image, native amd64) is a **resident JVM holding ~500 MB–1 GB RSS** — and a JVM does not give memory back when idle. Adding that to the baseline:

- baseline becomes ~1.3–2.0 GB **before any job runs**;
- add worst-case job overlap and the box needs ~2.1–2.7 GB of its 1.9 GB.

**Verdict: a resident GROBID does NOT fit the current droplet.** It would live in the exact failure mode the budget exists to prevent — permanent swap pressure at best, PHP-FPM OOM-kill (site-wide 502s) at worst. A Docker `--memory` cap changes *who dies* (the container gets OOM-killed instead of PHP-FPM, and conversion falls back to regex — safe), but it does not change the swap pressure while GROBID runs. Per the house rule: swap is a crash pad, not capacity.

Also weigh frequency: the escalation gate means GROBID is only consulted for the minority of PDF books whose bibliography scores suspect — this is a low-QPS, bursty service, not a hot path. That shapes which option below makes sense.

## 2. Pick ONE hosting option

### Option A — resize the droplet first, then run GROBID beside the app (the adoption path)

Resizing to 4 GB is *already* the documented step 1 for import concurrency (`deploy/supervisor/README.md` order of operations), so GROBID rides an upgrade you want anyway. Post-resize math: baseline ~1 GB + worst-case jobs ~0.9 GB + GROBID capped at 1 GB ≈ 2.9 GB of ~3.8 GB usable — fits with headroom. Choose this if you're adopting GROBID for real (and optionally take `numprocs=2` on imports in the same resize).

### Option B — a dedicated micro-droplet for GROBID (prod hosting without resizing)

A separate small droplet (2 GB is plenty for the CRF image) running ONLY GROBID, on the same DigitalOcean VPC, with `GROBID_URL=http://<private-ip>:8070`. Blast radius zero: if it OOMs, hangs, or you delete it, the app falls back to regex. Latency is irrelevant (escalations are rare and jobs are minutes long anyway). This is the production alternative to resizing — NOT the trial vehicle: the adoption trial needs no server at all, it runs locally (native-JVM GROBID on a dev Mac + `GROBID_ALWAYS=1` over the PDF-bearing fixtures; conversion replay is deterministic from `ocr_response.json` + the PDF). Only pick A or B after that local trial says GROBID beats the regex on real books.

### Option C — capped container on the current box (documented, NOT recommended)

`docker run --memory=800m --memory-swap=800m …` on the current droplet contains the blast (the cgroup OOM-kills GROBID, never PHP-FPM, and conversion falls back), but every escalation still shoves the box toward swap while imports run. Given the OOM history, only do this for a one-off experiment you're watching live with `free -m`, and stop the container after.

## 3. Install steps (options A and C run these ON the droplet; option B on the micro-droplet)

Check Docker exists (FlareSolverr's doc assumed it too): `docker --version`. If missing: `sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable --now docker`.

Run the container — note the **127.0.0.1 bind**: GROBID has NO authentication, it must never listen on the public interface (on option B's micro-droplet, bind to the VPC private IP instead and firewall port 8070 to the app droplet only):

```bash
docker pull lfoppiano/grobid:0.8.0
docker run -d --name grobid \
  --init \
  --memory=1g --memory-swap=1g \
  --restart=unless-stopped \
  -p 127.0.0.1:8070:8070 \
  lfoppiano/grobid:0.8.0
# wait ~20-60s for model load, then:
curl -s http://127.0.0.1:8070/api/isalive   # → true
```

(`--init` works on native amd64; the tini failure + entrypoint bypass in the local-dev notes was an ARM-Mac emulation quirk only. If you'd rather not use Docker at all, GROBID also runs from its release zip under supervisor with a JRE — same pattern the FlareSolverr doc describes — but the container is the maintained path.)

## 4. Wire the env into the IMPORT worker (supervisor, not .env)

Laravel does not pass `.env` into child processes, so the Python pipeline reads `GROBID_URL` from the **worker process environment**. Only `hyperlit-worker` (imports/reconverts on `default`) needs it; add one line to `deploy/supervisor/hyperlit-worker.conf` under `[program:hyperlit-worker]`:

```ini
environment=GROBID_URL="http://127.0.0.1:8070"
```

(Option B: the private IP instead of 127.0.0.1. If you later want vibe re-conversions to escalate too, add the same line to `hyperlit-vibe.conf` — start without it.)

Commit the conf change and deploy normally — `./deploy/deploy.sh` sees the changed `.conf`, offers the supervisor install, and restarts the workers. By hand instead: `sudo cp deploy/supervisor/hyperlit-worker.conf /etc/supervisor/conf.d/ && sudo supervisorctl reread && sudo supervisorctl update && php artisan queue:restart`.

Tuning knobs (worker env, all optional): `GROBID_REQUEST_TIMEOUT` (default 120s/request), `GROBID_TOTAL_DEADLINE` (default 300s/document), `GROBID_ALWAYS=1` (skip the health gate and try GROBID on every PDF book — corpus trials only, unset it after).

## 5. Verify with a real escalation

Book `93d34a74-72b3-4ec1-8f0b-7f9e9bac0add` is the designated test case (its fixture manifest carries the `grobid_candidate` note): its bibliography health-scores suspect (14 glued run-on entries), so a reconvert exercises the full path:

```bash
sudo -u www-data php artisan library:reconvert-system-version --book=93d34a74-72b3-4ec1-8f0b-7f9e9bac0add
grep -m2 '🧪\|via grobid' storage/logs/worker.log            # "Bibliography suspect (…) — escalating to GROBID"
python3 - <<'EOF'
import json
a = json.load(open('resources/markdown/93d34a74-72b3-4ec1-8f0b-7f9e9bac0add/assessment.json'))
print([r['decision'] for r in a['records'] if r['module'] in ('bibliography_health', 'bibliography_extraction')])
EOF
```

Success looks like a `bibliography_health` record (`suspect=True → GROBID attempt`) followed by a `bibliography_extraction` decision ending `[via grobid]` — and in the reader, "(Al-Awqati, 2007)" finally links. If the extraction record does NOT say `via grobid`, the fallback fired; `docker logs grobid` and the worker log's ⚠️ line say why (that state is safe — it just means regex ran, same as before).

## 6. Measure it (the budget is only real if it stays measured)

During the verification reconvert, on the droplet: `free -m` before/during/after, and `docker stats grobid --no-stream` for the container's true RSS. Append the measured number to the RAM budget in `deploy/supervisor/README.md` next to the other classes — the budget doc is the single place capacity decisions get made from, and GROBID is now part of that math. If the measured resident RSS lands above ~1 GB on option A's 4 GB box, lower the container cap or reconsider option B.

## 7. Rollback (any time, instantly safe)

Remove the `environment=` line (redeploy or `supervisorctl` reload) or just `docker stop grobid`. Conversion self-heals to the regex path on the very next job — that is the designed contract, verified by the unit suite (`tests/conversion/unit/test_grobid_bibliography.py`: server-down, mid-request death, and thin-result cases all fall back). Books already converted via GROBID keep their (better) bibliographies until their next reconvert.

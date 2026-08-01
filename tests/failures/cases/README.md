# Case drop-folder — production job failures pulled from prod

Tarballs (`failure-<key>.tar.gz`) in this folder are **failure bundles** exported from production by the `/maintainer/jobs` triage page's "⤓ case bundle" button (or `php artisan failure:export <key>`). Each describes ONE failure group — the same job failing the same way, collapsed from the `failed_jobs` table — and carries the full stack trace, every row's decoded payload, worker-log excerpts around each failure, the deployed git sha, and the affected book ids.

Everything here except this README is git-ignored — bundles are local working material.

## If you are Claude (or any LLM asked to "look at the new job failures")

Each unpacked bundle has its own `README.md` written as the prompt for that specific failure; read it first. This checklist is the loop around them:

1. **Ingest whatever is sitting here**: run `php artisan failure:import-cases --downloads` (the `--downloads` flag also sweeps `~/Downloads`, since the browser chooses where the triage page's download lands). Each bundle unpacks to `tests/failures/cases/<key>/` and the tarball is archived to `ingested/`.
2. **Read `exception.txt`, then the source it names.** The trace gives you the file and line. Read that code before forming a theory.
3. **Check the timeline before assuming it's live.** `context.json` carries `first_seen`, `last_seen`, and the git sha that was deployed. Failures clustered on one date are usually an incident — a bad deploy, an OOM, a worker still holding pre-migration code — and a group that stopped on its own was probably fixed by a later commit. Confirm with `git log` rather than re-fixing something.
4. **Sort the failure into its shape**, because each wants a different fix: a **code bug** (fix + regression test), an **environment fault** (permissions, a missing binary, an OOM kill — fix the host or the deploy, and ask whether the job should fail loudly rather than silently), or a **data-shaped failure** where one book's content breaks an assumption (that's a conversion case: `php artisan book:export <book>` on prod and switch to the `tests/conversion/cases/` loop).
5. **Reproduce before fixing** — dispatch the job locally with the arguments from `failures.json`, or encode the payload in a failing test. Note which jobs are paid (`context.json` → `paid_class`): reproduce those against a fixture, never by firing the real billed API call.
6. **Ask whether the failure was visible at all.** These groups sat unseen for months. If a user was waiting on the job and it has no `failed()` handler in `app/Jobs/`, adding that notification may matter more than the fix.
7. **Lock it in** with a test under `tests/Feature/`, then `npm run test:run` and `php artisan test`.
8. **Hand back to the human**: they deploy with `./deploy/deploy.sh`, then forget the group on `/maintainer/jobs` (or retry it there if the work still needs to happen — retrying a paid class re-charges).

## If you are a human

Drag the downloaded `failure-<key>.tar.gz` here (or leave it in Downloads), then either run `php artisan failure:import-cases --downloads` yourself — or open Claude and say: `@tests/failures/cases/ production job failures to fix`.

Related: `deploy/supervisor/README.md` for which worker runs which job class, and `docs/maintainer-loop.md` for the bad-conversion sibling of this loop.

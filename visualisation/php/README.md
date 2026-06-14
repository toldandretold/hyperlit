# visualisation/php — PHP collector (planned)

This folder is the **seam for the backend half of the data-flow map** — it does not exist yet.

When built, it will parse the Laravel side and emit graph nodes/edges that `../merge.ts`
joins onto the JS graph at the shared HTTP endpoint URL:

```
[HTTP endpoint] → PHP route (routes/api.php) → Controller@method → Eloquent model / DB::table() → Postgres table
```

### Intended approach
- Extract `method + URI → Controller@method` from `routes/api.php` (+ `web.php`).
- For each controller method, find the model / `DB::table('…')` it reads or writes.
- Parser: [`nikic/php-parser`](https://github.com/nikic/PHP-Parser) **or** a small `artisan`
  command using `Route::getRoutes()` + reflection (no new dependency).
- Emit `route` / `controller` / `model` nodes + edges into the existing `table` nodes.

### Why this is tractable
The JS generator already records each endpoint URL on its `push`/`pull` edges
(`ENDPOINT_TABLES` in `../js/collect.ts`). The PHP side keys routes by the same normalized
URL, so the two graphs stitch together on it. As a bonus, the endpoint→table mapping that's
currently **hand-maintained** in `ENDPOINT_TABLES` would become **derived from the controllers**.

See the "Next: the PHP tier" section of `../README.md` for the full sketch.

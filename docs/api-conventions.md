# API response conventions

The standard JSON shape for API endpoints. This is the **existing de-facto
convention** the SPA already depends on — derived by surveying `resources/js`, not
invented. The F5/F6/F7 sweep means bringing *deviating* endpoints onto this shape;
it does **not** mean introducing a new envelope (that would break the frontend).

## How the SPA consumes responses (the constraints)

- **No central fetch wrapper.** Native `fetch` everywhere, inline handling.
- **HTTP status is the primary signal** — `!response.ok` is checked ~47×; callers
  branch on `401/402/409/410/422/504` directly. So **status codes must be right.**
- Then a **`success` boolean** (read ~39×), a **`message`** string (~56×), and
  **`errors`** as `{field: [msg, …]}` on validation (~7×). Special error *codes*
  travel in **`error`** (e.g. `error: 'STALE_DATA'`, ~21×).
- **Payloads sit under their own named keys** (`library`, `overrides`, `nodes`,
  `user`…), **never** a generic `data` wrapper. Wrapping them breaks the SPA.

## The shape

```jsonc
// success
{ "success": true, "library": { … }, "message": "Saved" }   // payload under named key(s)

// validation failure (HTTP 422)
{ "success": false, "message": "Validation failed", "errors": { "book": ["required"] } }

// other error (auth/not-found/conflict/server) — pick the right HTTP status
{ "success": false, "message": "Forbidden" }
{ "success": false, "error": "STALE_DATA", "message": "…", "server_timestamp": 123 }
```

Status codes: `422` validation · `401` unauthenticated · `402` billing · `403`
forbidden · `404` not found · `409` conflict · `500` server. **Not** `400` for
validation (the deviation we're removing).

## How to apply it

Use `App\Http\Responses\ApiResponse`: `ApiResponse::ok([...], $msg)`,
`ApiResponse::validationError($validator->errors())`, `ApiResponse::error($msg, $status)`.

- **HTTP-only endpoints** → a Form Request (`app/Http/Requests/*`) is cleanest;
  its `failedValidation` should return the `ApiResponse::validationError` shape.
- **Dual-entry endpoints** (`db/*` sync endpoints called over HTTP *and* internally
  by `UnifiedSyncController`) → **do NOT** type-hint a Form Request (it TypeErrors
  when the orchestrator passes a plain `Request`). Validate inline with
  `Validator::make(...)` + `ApiResponse::validationError(...)` instead — that also
  validates the orchestrator's path, which a route-only Form Request would skip.

## Migration is incremental + cross-stack

Each endpoint changes a contract the SPA reads, so migrate **one at a time**:
change the controller → confirm the specific `resources/js` consumer only reads
fields the new shape still provides → flip its Pest test. The Pest suite pins the
contract; the Playwright `specs/` are the broad integration net. Worked example:
`DbHyperciteController::upsert` (see findings F5/F6/F7).

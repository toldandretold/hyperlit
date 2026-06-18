<?php

namespace App\Http\Controllers;

use App\Models\Vibe;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * The `vibes` gallery API (CSS-override presets). All responses must stay in sync with the TS
 * contract `Vibe` / `VibeInput` (`components/settingsContainer/vibeCSS/api.ts`). `css_overrides` is
 * the jsonb map; `creator_token` is hidden on the model and never sent; `creator`/`pull_count` only
 * ship on the PUBLIC payload.
 */
class VibesController extends Controller
{
    /**
     * List the authenticated user's saved vibes (the `mine` LOAD shape → TS `Vibe[]`).
     *
     * @return \Illuminate\Http\JsonResponse array{vibes: array<int, array{
     *   id: string, name: string, prompt: ?string, css_overrides: array<string,string>,
     *   visibility: string, source_creator: ?string, created_at: string
     * }>}
     */
    public function mine(Request $request)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['message' => 'Unauthenticated'], 401);
        }

        $vibes = Vibe::where('creator', $user->name)
            ->orderBy('created_at', 'desc')
            ->get(['id', 'name', 'prompt', 'css_overrides', 'visibility', 'source_creator', 'created_at']);

        return response()->json(['vibes' => $vibes]);
    }

    /**
     * Save a new vibe (limit: 5 per user) — the SAVE path for TS `VibeInput`; backend sets
     * creator (= user name), `creator_token` = null, id/created_at. A `source_vibe_id` bumps that
     * public vibe's `pull_count`.
     *
     * @return \Illuminate\Http\JsonResponse array{vibe: array{
     *   id: string, name: string, prompt: ?string, css_overrides: array<string,string>,
     *   visibility: string, created_at: string
     * }} | array{message: string}
     */
    public function store(Request $request)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['message' => 'Unauthenticated'], 401);
        }

        $validated = $request->validate([
            'name' => 'required|string|max:100',
            'css_overrides' => 'required|array',
            'prompt' => 'nullable|string|max:500',
            'visibility' => 'nullable|string|in:private,public',
            'source_vibe_id' => 'nullable|string|uuid',
            'source_creator' => 'nullable|string|max:255',
        ]);

        // Enforce 5 vibe limit
        $count = Vibe::where('creator', $user->name)->count();
        if ($count >= 5) {
            return response()->json([
                'message' => 'You can save up to 5 vibes. Delete one to make room.',
            ], 422);
        }

        $vibe = Vibe::create([
            'name' => $validated['name'],
            'css_overrides' => $validated['css_overrides'],
            'prompt' => $validated['prompt'] ?? null,
            'visibility' => $validated['visibility'] ?? 'private',
            'creator' => $user->name,
            'creator_token' => null,
            'source_creator' => $validated['source_creator'] ?? null,
        ]);

        if ($sourceId = $validated['source_vibe_id'] ?? null) {
            DB::connection('pgsql_admin')->update(
                "UPDATE vibes SET pull_count = pull_count + 1 WHERE id = ? AND visibility = 'public'",
                [$sourceId]
            );
        }

        return response()->json([
            'vibe' => $vibe->only(['id', 'name', 'prompt', 'css_overrides', 'visibility', 'created_at']),
        ], 201);
    }

    /**
     * Update name or visibility of an owned vibe (owner-only; only those two fields are mutable).
     * Response is the same `vibe` shape as store().
     *
     * @return \Illuminate\Http\JsonResponse array{vibe: array{id,name,prompt,css_overrides,visibility,created_at}} | array{message: string}
     */
    public function update(Request $request, string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['message' => 'Unauthenticated'], 401);
        }

        $validated = $request->validate([
            'name' => 'sometimes|string|max:100',
            'visibility' => 'sometimes|string|in:private,public',
        ]);

        $vibe = Vibe::where('id', $id)->where('creator', $user->name)->first();
        if (!$vibe) {
            return response()->json(['message' => 'Vibe not found'], 404);
        }

        $vibe->update($validated);

        return response()->json([
            'vibe' => $vibe->only(['id', 'name', 'prompt', 'css_overrides', 'visibility', 'created_at']),
        ]);
    }

    /**
     * Delete an owned vibe (owner-only).
     *
     * @return \Illuminate\Http\JsonResponse array{success: true} | array{message: string}
     */
    public function destroy(Request $request, string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['message' => 'Unauthenticated'], 401);
        }

        $vibe = Vibe::where('id', $id)->where('creator', $user->name)->first();
        if (!$vibe) {
            return response()->json(['message' => 'Vibe not found'], 404);
        }

        $vibe->delete();

        return response()->json(['success' => true]);
    }

    /**
     * Browse public vibes (no auth) — the PUBLIC gallery → TS `Vibe[]` (carries `creator`/`pull_count`,
     * omits `source_creator`/`visibility`). Page size 50; `sort` = 'top' (pull_count) | 'new'.
     *
     * @return \Illuminate\Http\JsonResponse array{vibes: array<int, array{
     *   id: string, name: string, prompt: ?string, css_overrides: array<string,string>,
     *   creator: ?string, pull_count: int, created_at: string
     * }>, has_more: bool}
     */
    public function publicIndex(Request $request)
    {
        $limit = 50;
        $offset = max(0, (int) $request->query('offset', 0));

        $sort = $request->query('sort', 'top');

        $query = Vibe::where('visibility', 'public');

        if ($sort === 'new') {
            $query->orderBy('created_at', 'desc');
        } else {
            $query->orderBy('pull_count', 'desc')
                  ->orderBy('created_at', 'desc');
        }

        $vibes = $query->offset($offset)
            ->limit($limit + 1)
            ->get(['id', 'name', 'prompt', 'css_overrides', 'creator', 'pull_count', 'created_at']);

        $hasMore = $vibes->count() > $limit;
        if ($hasMore) $vibes->pop();

        return response()->json([
            'vibes'    => $vibes,
            'has_more' => $hasMore,
        ]);
    }
}

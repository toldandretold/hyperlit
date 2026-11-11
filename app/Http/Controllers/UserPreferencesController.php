<?php

namespace App\Http\Controllers;

use App\Support\UserPreferencesStore;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class UserPreferencesController extends Controller
{
    private const ALLOWED_KEYS = [
        'theme', 'vibe_css', 'full_width', 'gate_filter',
        'embed_private_books',                           // Data panel: semantic search for private books (default true)
        'reading_mode',                                  // legacy (pre device-scoping)
        'text_size', 'content_width',                    // legacy
        'text_size_mobile', 'text_size_desktop',
        'content_width_mobile', 'content_width_desktop',
        'reading_mode_mobile', 'reading_mode_desktop',
        // Notification controls (NotificationWriter::allowed) — booleans, absent = on.
        // notify_muted is NOT here: only NotificationController::mute/unmute write it.
        'notify_hyperlight', 'notify_suggested_edit', 'notify_hypercite', 'notify_like',
        'notify_anonymous',
    ];

    /** Keys whose value must be a boolean (or null to clear) — the writer compares `=== false`. */
    private const BOOLEAN_KEYS = [
        'notify_hyperlight', 'notify_suggested_edit', 'notify_hypercite', 'notify_like',
        'notify_anonymous',
    ];

    // Device-scoped base keys. The client only ever WRITES the suffixed variant
    // (savePreference in utilities/preferences.ts appends _mobile/_desktop), so a
    // clear of the base key must also clear those variants — otherwise the stored
    // device pref is un-clearable and leaks forever (poisons cold-boot reading
    // mode + defeats the e2e self-heal in auth.setup.js).
    private const DEVICE_SCOPED = ['reading_mode', 'text_size', 'content_width'];

    public function show(Request $request): JsonResponse
    {
        return response()->json($request->user()->preferences ?? []);
    }

    public function update(Request $request): JsonResponse
    {
        $user = $request->user();
        $current = $user->preferences ?? [];

        $incoming = $request->only(self::ALLOWED_KEYS);

        foreach (self::BOOLEAN_KEYS as $key) {
            if (array_key_exists($key, $incoming) && ! is_null($incoming[$key]) && ! is_bool($incoming[$key])) {
                return response()->json([
                    'message' => "The {$key} preference must be true or false.",
                    'errors' => [$key => ['Must be a boolean.']],
                ], 422);
            }
        }

        foreach ($incoming as $key => $value) {
            if (is_null($value)) {
                // Clearing a device-scoped base key clears its _mobile/_desktop
                // variants too (the client writes those, never the base key).
                foreach ($this->clearTargets($key) as $target) {
                    unset($current[$target]);
                }
            } else {
                $current[$key] = $value;
            }
        }

        UserPreferencesStore::write((int) $user->id, $current);

        return response()->json($current);
    }

    /**
     * Keys to unset when clearing $key: a device-scoped base key expands to
     * itself plus its _mobile/_desktop variants; everything else is just itself.
     *
     * @return string[]
     */
    private function clearTargets(string $key): array
    {
        if (in_array($key, self::DEVICE_SCOPED, true)) {
            return [$key, "{$key}_mobile", "{$key}_desktop"];
        }

        return [$key];
    }
}

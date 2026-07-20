<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class UserPreferencesController extends Controller
{
    private const ALLOWED_KEYS = [
        'theme', 'vibe_css', 'full_width', 'gate_filter',
        'reading_mode',                                  // legacy (pre device-scoping)
        'text_size', 'content_width',                    // legacy
        'text_size_mobile', 'text_size_desktop',
        'content_width_mobile', 'content_width_desktop',
        'reading_mode_mobile', 'reading_mode_desktop',
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

        $preferences = $current ?: null;

        $affected = DB::connection('pgsql_admin')->table('users')
            ->where('id', $user->id)
            ->update(['preferences' => $preferences ? json_encode($preferences) : null]);

        if ($affected === 0) {
            Log::warning('Preferences update affected 0 rows', ['user_id' => $user->id]);
        }

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

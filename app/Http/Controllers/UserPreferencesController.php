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
        'text_size', 'content_width',                    // legacy
        'text_size_mobile', 'text_size_desktop',
        'content_width_mobile', 'content_width_desktop',
    ];

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
                unset($current[$key]);
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
}

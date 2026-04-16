<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class UserPreferencesController extends Controller
{
    private const ALLOWED_KEYS = ['theme', 'vibe_css', 'text_size', 'content_width', 'full_width'];

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

        $user->preferences = $current ?: null;
        $user->save();

        return response()->json($current);
    }
}

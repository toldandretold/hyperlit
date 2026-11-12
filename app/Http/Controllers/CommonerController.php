<?php

namespace App\Http\Controllers;

use App\Services\Commoner\CommonerScoreService;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;

/**
 * The private, own-view read of a user's commoner score ("hectares of the
 * commons tilled"). v1 is deliberately NOT public — only the authenticated
 * caller's own breakdown is ever returned, read from their stored daily
 * snapshot via CommonerScoreService::breakdownFor (pgsql_admin); a user never
 * computed before is computed once on this first read.
 */
class CommonerController extends Controller
{
    public function me(CommonerScoreService $scores): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        return response()->json($scores->breakdownFor($user->name));
    }
}

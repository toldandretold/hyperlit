<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use App\Mail\IntegrityReportMail;
use App\Models\PgNodeChunk;

class IntegrityReportController extends Controller
{
    public function report(Request $request)
    {
        $data = $request->validate([
            'bookId'         => 'required|string|max:500',
            'mismatches'     => 'nullable|array|max:50',
            'mismatches.*.nodeId'  => 'string|max:50',
            'mismatches.*.domText' => 'nullable|string|max:500',
            'mismatches.*.idbText' => 'nullable|string|max:500',
            'missingFromIDB'           => 'nullable|array|max:50',
            'missingFromIDB.*.nodeId'  => 'string|max:50',
            'missingFromIDB.*.tag'     => 'nullable|string|max:20',
            'missingFromIDB.*.domText' => 'nullable|string|max:500',
            'duplicateIds'        => 'nullable|array|max:50',
            'duplicateIds.*.id'   => 'string|max:50',
            'duplicateIds.*.count' => 'integer|min:2',
            'recentLogs'        => 'nullable|array|max:50',
            'recentLogs.*.level' => 'nullable|string|max:10',
            'recentLogs.*.ts'    => 'nullable|numeric',
            'recentLogs.*.msg'   => 'nullable|string|max:2000',
            'trigger'        => 'nullable|string|max:50',
            'url'            => 'nullable|string|max:2000',
            'userAgent'      => 'nullable|string|max:1000',
            'timestamp'      => 'nullable|string|max:100',
            'context'                    => 'nullable|array',
            'context.totalDomNodes'      => 'nullable|integer',
            'context.sessionAgeSec'      => 'nullable|integer',
            'context.idbBroken'          => 'nullable|boolean',
            'selfHealed'         => 'nullable|boolean',
            'selfHealedNodeIds'  => 'nullable|array|max:100',
            'selfHealedNodeIds.*' => 'string|max:50',
            'comment'            => 'nullable|string|max:2000',
        ]);

        $user = Auth::user();
        $data['userId'] = $user?->id;
        $data['userName'] = $user?->name ?? 'anonymous';

        // Server-side context
        $data['pgNodeCount'] = PgNodeChunk::where('book', $data['bookId'])->count();
        $data['laravelLogs'] = $this->grepLaravelLog($data['bookId'], 20);

        Log::warning('Integrity mismatch report', $data);

        try {
            Mail::send(new IntegrityReportMail($data));
        } catch (\Exception $e) {
            Log::error('Failed to send integrity report email', [
                'error' => $e->getMessage(),
            ]);
        }

        $premiumGranted = false;
        if ($user) {
            $user->status = 'premium';
            $user->save();
            $premiumGranted = true;
            Log::info('Premium granted for integrity report', ['userId' => $user->id]);
        }

        return response()->json([
            'status' => 'received',
            'premium_granted' => $premiumGranted,
        ]);
    }

    public function claimPremium(Request $request)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Not authenticated'], 401);
        }

        $user->status = 'premium';
        $user->save();
        Log::info('Premium claimed via integrity report', ['userId' => $user->id]);

        return response()->json([
            'status' => 'granted',
            'premium_granted' => true,
        ]);
    }

    private function grepLaravelLog(string $bookId, int $limit): array
    {
        try {
            $path = storage_path('logs/laravel.log');

            if (!is_file($path) || !is_readable($path)) {
                return [];
            }

            $escaped = escapeshellarg($bookId);
            $limit = max(1, (int) $limit);
            $lines = [];
            exec("grep {$escaped} {$path} | tail -n {$limit}", $lines);

            return array_map(fn($line) => mb_substr($line, 0, 500), $lines);
        } catch (\Throwable $e) {
            return [];
        }
    }
}

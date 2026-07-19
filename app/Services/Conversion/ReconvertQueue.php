<?php

namespace App\Services\Conversion;

use App\Models\ConversionFlag;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * The reconvert queue's shared brain — open conversion_flags grouped per
 * book, joined to the library row, with on-disk artifact availability and a
 * suggested action. Two consumers: `library:reconvert-queue` (terminal) and
 * the /maintainer triage page (MaintainerController API).
 */
class ReconvertQueue
{
    /**
     * @return array[] one entry per flagged book:
     *  {book, title, creator, conversion_method, completeness,
     *   artifacts: string[], suggested: reconvert|re-fetch|inspect,
     *   flags: [{source, reason, report_count, details, created_at}]}
     */
    public function openFlagsGrouped(): array
    {
        $flags = ConversionFlag::where('status', 'open')->orderBy('created_at')->get();
        if ($flags->isEmpty()) {
            return [];
        }

        $libRows = DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', $flags->pluck('book')->unique())
            ->get(['book', 'title', 'creator', 'conversion_method', 'completeness', 'doi', 'pdf_url', 'oa_url'])
            ->keyBy('book');

        $out = [];
        foreach ($flags->groupBy('book') as $bookId => $bookFlags) {
            $lib = $libRows->get($bookId);
            $artifacts = $this->artifactsFor($bookId);

            $out[] = [
                'book'              => $bookId,
                'title'             => strip_tags((string) ($lib->title ?? '(no library row)')),
                'creator'           => $lib->creator ?? null,
                'conversion_method' => $lib->conversion_method ?? null,
                'completeness'      => $lib->completeness ?? null,
                'artifacts'         => $artifacts,
                'suggested'         => $this->suggestAction($artifacts, $lib),
                'flags'             => $bookFlags->map(fn ($f) => [
                    'source'       => $f->source,
                    'reason'       => $f->reason,
                    'report_count' => (int) ($f->details['report_count'] ?? 1),
                    'details'      => $f->details,
                    'created_at'   => $f->created_at?->toIso8601String(),
                ])->values()->all(),
            ];
        }

        return $out;
    }

    /** Which conversion artifacts exist on disk for this book. */
    public function artifactsFor(string $bookId): array
    {
        $dir = resource_path("markdown/{$bookId}");
        if (!is_dir($dir)) {
            return [];
        }

        $found = [];
        foreach (File::glob("{$dir}/original.*") as $f) {
            $found[] = basename($f);
        }
        foreach (['ocr_response.json', 'assessment.json', 'epub_original'] as $name) {
            if (file_exists("{$dir}/{$name}")) {
                $found[] = $name;
            }
        }

        return $found;
    }

    /** reconvert (source on disk) | re-fetch (URL identity only) | inspect. */
    public function suggestAction(array $artifacts, ?object $lib): string
    {
        $hasSource = (bool) array_filter(
            $artifacts,
            fn ($a) => str_starts_with($a, 'original.') || $a === 'ocr_response.json' || $a === 'epub_original',
        );
        if ($hasSource) {
            return 'reconvert';
        }
        if ($lib && ($lib->doi || $lib->pdf_url || $lib->oa_url)) {
            return 're-fetch';
        }

        return 'inspect';
    }
}

<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One "this book's conversion is suspect" signal — the rows behind
 * `library:reconvert-queue`. See the create_conversion_flags_table migration
 * for the design (open-flag upsert semantics, no RLS, history kept).
 */
class ConversionFlag extends Model
{
    protected $table = 'conversion_flags';

    protected $fillable = [
        'book', 'source', 'reason', 'details', 'status', 'resolution', 'resolved_at',
    ];

    protected $casts = [
        'details'     => 'array',
        'resolved_at' => 'datetime',
    ];

    public const SOURCE_USER_REPORT = 'user_report';
    public const SOURCE_AUTO_SWEEP  = 'auto_sweep';
    public const SOURCE_MANUAL      = 'manual';

    /**
     * Upsert the single OPEN flag for (book, source): create it, or fold the
     * new signal into the existing one (bump report_count, merge details,
     * refresh reason). Returns the open flag.
     */
    public static function raise(string $book, string $source, ?string $reason, array $details = []): self
    {
        $open = self::where('book', $book)->where('source', $source)
            ->where('status', 'open')->first();

        if (!$open) {
            return self::create([
                'book'    => $book,
                'source'  => $source,
                'reason'  => $reason,
                'details' => $details + ['report_count' => 1],
                'status'  => 'open',
            ]);
        }

        $merged = array_merge($open->details ?? [], $details);
        $merged['report_count'] = (int) ($open->details['report_count'] ?? 1) + 1;
        $open->details = $merged;
        if ($reason !== null && $reason !== '') {
            $open->reason = $reason;
        }
        $open->save();

        return $open;
    }

    /** Close the book's open flags (all sources) with a resolution. */
    public static function resolveFor(string $book, string $resolution, array $extraDetails = []): int
    {
        $count = 0;
        foreach (self::where('book', $book)->where('status', 'open')->get() as $flag) {
            $flag->status = $resolution === 'dismissed' ? 'dismissed' : 'resolved';
            $flag->resolution = $resolution;
            $flag->resolved_at = now();
            if ($extraDetails) {
                $flag->details = array_merge($flag->details ?? [], $extraDetails);
            }
            $flag->save();
            $count++;
        }

        return $count;
    }
}

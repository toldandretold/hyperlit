<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * In-app notification for a book owner (see NotificationWriter for the write
 * side — rows are inserted via pgsql_admin; this model reads on the default
 * connection where RLS scopes rows to the logged-in recipient).
 */
class PgNotification extends Model
{
    protected $table = 'notifications';

    public const UPDATED_AT = null;

    protected $fillable = [
        'recipient',
        'actor',
        'type',
        'book',
        'root_book',
        'subject_id',
        'citing_ref',
        'data',
        'read_at',
    ];

    protected $casts = [
        'data' => 'array',
        'read_at' => 'datetime',
        'created_at' => 'datetime',
    ];
}

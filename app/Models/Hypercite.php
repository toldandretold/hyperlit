<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Hypercite extends Model
{
    use HasFactory;

    protected $fillable = ['citation_id_a', 'hypercite_id', 'hypercited_text', 'href_a'];

    public function links()
    {
        return $this->hasMany(HyperciteLink::class, 'hypercite_id_x', 'hypercite_id');
    }
}

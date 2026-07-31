<?php

namespace App\Services\Audiobook;

/**
 * The audiobook cannot be packaged, for a reason the user should be told:
 * nothing narrated yet, the book is encrypted (the server can't read its
 * audio), or the host has no ffmpeg. Message is user-facing.
 */
class AudiobookUnavailable extends \RuntimeException {}

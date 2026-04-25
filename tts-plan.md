# TTS / Audio Player — Plan Notes

## The model
- **Kokoro-82M** — open source (Apache 2.0), released late 2024
- 82M params, runs on CPU faster than realtime
- Quality roughly on par with OpenAI's `tts-1`
- ~10 built-in voices (American/British, M/F)
- Free forever, no API keys

## Where it runs
- Same DigitalOcean Droplet as Laravel
- Small Python FastAPI service on `localhost:8001`
- Persistent process under systemd (loads model once, ~500MB RAM)
- Needs ≥2GB RAM Droplet, ideally 4GB

## Storage
- One MP3 per article chunk (we already have `PgNodeChunk` rows)
- Saved to S3 disk: `audio/{book}/{voice}/{chunk_id}.mp3`
- New `article_audio` table tracks `book_id, voice, chunk_id, path, duration, status`
- ~1MB per minute of audio, ~30GB for full 1000-article library
- Cached forever, regenerate only if chunk text changes

## Background pre-warming
- Laravel scheduled command runs overnight (`Schedule::command(...)->between('2:00', '6:00')`)
- Picks top-viewed articles missing audio, dispatches `GenerateArticleAudio` jobs
- Optional: load-average aware (only run when `sys_getloadavg()[0] < 0.5`)
- Pre-generate **default voice only**; alt voices generated on demand

## "Listen now" → priority queue jump
- If a user clicks Listen on an un-cached article, dispatch the job to a **high-priority queue**
- Use a separate queue name (e.g. `audio-priority`) and run a dedicated worker for it
- Or use Laravel's queue priority: `dispatch($job)->onQueue('high')` and run worker with `--queue=high,default`
- Frontend polls `/audio/status/{book}/{voice}` every ~2 sec, shows "Generating… ~20 sec" progress
- First chunk only needs to finish before playback starts; remaining chunks stream in behind it

## Playback UX
- New button in existing settings panel (`resources/views/components/settings-panel.blade.php`)
- Click → floating control bar slides up from bottom of screen
- Controls:
  - Play / Pause
  - Skip back 15s, skip forward 15s
  - Speed: 0.75× / 1× / 1.25× / 1.5× / 2×
  - Voice picker (dropdown of available Kokoro voices)
  - Close button
- Uses plain HTML5 `<audio>` element under the hood
- Highlight currently-reading paragraph (we know chunk boundaries → `timeupdate` listener)

## Lock-screen / phone-off playback
- Free with `<audio>` + **MediaSession API**
- Set `navigator.mediaSession.metadata` (title, artist, artwork)
- Wire `setActionHandler` for play/pause/seekforward/seekbackward
- Works on iOS Safari, Android Chrome, desktop — lock screen, headphones, car bluetooth all "just work"
- This is the killer feature vs. browser `speechSynthesis` (which dies when screen locks)

## Why not browser SpeechSynthesis?
- Free and zero infra, but:
  - Stops when phone locks (especially iOS)
  - Voice quality wildly inconsistent across OSes
  - Can't pre-generate / cache
- Worth skipping straight to Kokoro

## Build order
1. Python FastAPI + Kokoro service, smoke test with `curl`
2. `php artisan tts:test {book}` command — generate one MP3, listen, pick a voice
3. Laravel Job + `article_audio` migration + 2 routes (generate, status)
4. Frontend audio bar + MediaSession wiring
5. Scheduled pre-warm command
6. Priority queue for "Listen now" clicks

## Rough costs
- Droplet: $0 extra if existing has 4GB+ RAM, else +$12/mo
- S3 storage: ~$0.70/mo for 30GB
- Per generation: free (CPU time only)
- Per listen: free (static MP3)

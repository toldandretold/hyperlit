# Citation Scan Pipeline — Cost Estimates

## Current pipeline (per citation)

| Step | Service | Cost | Notes |
|------|---------|------|-------|
| DOI extraction | Regex (local) | $0 | No API call |
| LLM metadata extraction | Fireworks (Qwen3-8b) | ~$0.00004 | ~210 tokens @ $0.20/1M |
| Library table search | PostgreSQL (local) | $0 | ILIKE query |
| OpenAlex title search | OpenAlex API | $0 | Free, no key needed |
| Open Library fallback | Open Library API | $0 | Free, no key needed |

**Total per citation: ~$0.00004** (essentially just the LLM call)

## Batch estimates

| Book size | Citations | LLM cost | Time estimate |
|-----------|-----------|----------|---------------|
| Small | 50 | $0.002 | ~30s |
| Medium | 200 | $0.008 | ~2 min |
| Large | 500 | $0.02 | ~5 min |
| Very large | 1,000 | $0.04 | ~10 min |

## Token breakdown per LLM call

- **Input tokens:** ~150 (system prompt ~80 + citation text ~70)
- **Output tokens:** ~60 (JSON response with title, authors, year, journal, publisher)
- **Total:** ~210 tokens per citation
- **Model:** `accounts/fireworks/models/qwen3-8b`
- **Pricing:** $0.20 per 1M input tokens, $0.20 per 1M output tokens

## API rate limits

| Service | Rate limit | Our throttle |
|---------|-----------|--------------|
| Fireworks (Qwen3-8b) | ~600 RPM on free tier | 200ms between entries |
| OpenAlex | 10 req/s (polite pool) | 200ms between entries |
| Open Library | ~100 req/s (unofficial) | Only called as fallback |

## Resolution chain (in order)

1. **DOI** → OpenAlex lookup (instant, most reliable)
2. **Library table** → local PostgreSQL search (instant, no cost, catches re-scans)
3. **OpenAlex** → title search + metadataScore composite matching (free API)
4. **Open Library** → fallback for old/non-academic books (free API)
5. **No match** → logged with LLM metadata for manual review

## Future pipeline additions

_Space for additional steps as the pipeline grows._

| Step | Service | Estimated cost | Status |
|------|---------|---------------|--------|
| LLM metadata extraction | Fireworks Qwen3-8b | $0.00004/citation | Active |
| PDF retrieval | ? | ? | Planned |
| Full-text indexing | ? | ? | Planned |
| ... | ... | ... | ... |

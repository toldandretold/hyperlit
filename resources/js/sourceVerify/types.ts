// Shared types for the source-verification flow (the [check source] engine). Leaf module —
// imports nothing — so every consumer (sourceContainer, and later the post-conversion toast)
// can depend on it without coupling.

/** A candidate work in OpenAlexService::normaliseWork shape (only the fields we read/echo). */
export interface SourceCandidate {
  title?: string | null;
  author?: string | null;
  year?: number | string | null;
  journal?: string | null;
  publisher?: string | null;
  doi?: string | null;
  openalex_id?: string | null;
  open_library_key?: string | null;
  semantic_scholar_id?: string | null;
  type?: string | null;
  source?: string | null;
  match_score?: number | null;   // per-candidate confidence (0–1), set on shortlist candidates
  [key: string]: unknown;
}

/** The identifier subset sent to /source/verify so the server re-resolves authoritatively. */
export interface SourceIdentifier {
  openalex_id?: string;
  doi?: string;
  open_library_key?: string;
  semantic_scholar_id?: string;
}

/** Response of POST /api/library/{book}/source/lookup (CanonicalSourceMatcher::preview). */
export interface LookupResult {
  success: boolean;
  status: string;                 // linked_new | linked_existing | already_linked | no_match | error
  method: string | null;
  score: number | null;
  candidate: SourceCandidate | null;
  alternates: SourceCandidate[];
  alreadyLinked: boolean;
  current: SourceCandidate | null;
  message?: string;
}

/** Response of POST /api/library/{book}/source/verify. */
export interface VerifyResult {
  success: boolean;
  canonical_source_id?: string;
  library?: Record<string, unknown>;   // overwritten citation fields, for refreshing local state
  message?: string;
}

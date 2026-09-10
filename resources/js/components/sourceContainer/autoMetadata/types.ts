// Shapes for the auto-metadata ("magic wand") proposal flow. Zero-import leaf so
// both the pure extractor (local.ts) and the DOM/network layers can share them
// without a cycle.

/** The library-card fields the wand is allowed to touch. */
export type FieldKey = 'title' | 'author' | 'year' | 'type' | 'journal' | 'publisher';

export type Confidence = 'high' | 'medium' | 'low';

/**
 * One suggested change. `suggested` is NEVER empty — that is the structural
 * reason Apply can only ever fill or correct a field, never clear one.
 */
export interface FieldProposal {
  field: FieldKey;
  /** The record's current value, '' when unset. Re-checked at apply time. */
  current: string;
  suggested: string;
  confidence: Confidence;
  /** Human-readable "where this came from", shown on the card row. */
  provenance: string;
  /**
   * Ticked when the card opens. True when we are filling a blank or placeholder;
   * false when we would be replacing a value that looks deliberate — offered,
   * but the user has to reach for it.
   */
  checked?: boolean;
}

export interface MetadataProposal {
  tier: 'local' | 'ai';
  /** Only CHANGED fields. An empty array is a legitimate result, not an error. */
  fields: FieldProposal[];
  /** Why there is nothing (or little) to suggest — shown when `fields` is empty. */
  notes: string[];
}

/** The JSON contract of POST /api/citation-meta/extract. */
export interface AiMetadata {
  title: string | null;
  author: string | null;
  year: number | null;
  type: string | null;
  journal: string | null;
  publisher: string | null;
  /**
   * True when the text reads like the user's own note/draft/journal and names no
   * author — the client then drops the AI's author and falls back to the local
   * "your account" row rather than inventing a byline.
   */
  self_authored: boolean;
  confidence: Confidence;
}

export type AiRequestResult =
  | {
      ok: true;
      metadata: AiMetadata;
      /** Raw API cost, before the tier multiplier. Diagnostic only. */
      cost: number | null;
      /**
       * What actually hit the ledger (raw × the user's tier multiplier), taken
       * from the BillingLedger row the server wrote. Deliberately server-sent:
       * mirroring the tier table on the client would be a third copy of it, and
       * the second copy already drifted once (see FrontendPricingSyncTest).
       * Null under BYO, where nothing is charged.
       */
      charged: number | null;
    }
  | { ok: false; status: number; message: string };

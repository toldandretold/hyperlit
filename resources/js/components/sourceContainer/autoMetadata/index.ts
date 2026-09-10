// Auto metadata ("magic wand") — orchestration. Each function takes the
// SourceContainerManager as `self`, matching the panel's dispatch-hub idiom
// (see checkSource.ts / editForm.ts); the class delegates to these.
//
// The ladder:
//   1. FREE local pass (local.ts) — first heading, your username, a copyright
//      line. Instant, no network, works for encrypted books.
//   2. PAID AI pass (remote.ts) — only when the user asks for it, price shown up
//      front. Blocked for encrypted books: their plaintext must not leave here.
// Nothing is written until Apply, and Apply re-validates against a fresh record
// so a field the user changed in the meantime is dropped rather than clobbered.
import { openDatabase, prepareLibraryForIndexedDB } from '../../../indexedDB/index';
import { getNodesFromIndexedDB } from '../../../indexedDB/index';
import { forgetAutoDerivedTitle } from '../../../indexedDB/core/library';
import { generateBibtexFromForm } from '../../../utilities/bibtexProcessor';
import { getAuthContextSync } from '../../../utilities/auth/index';
import { isBookEncrypted } from '../../../e2ee/registry';
import { offerTopUp } from '../../../utilities/billing/topUp';
import { log, verbose } from '../../../utilities/logger';
import { book } from '../../../app';
import { getRecord } from '../helpers';
import { openingPlainText, proposeFromAi, proposeLocalMetadata } from './local';
import { AI_CHAR_LIMIT, AI_NODE_LIMIT, byoActive, requestAiMetadata } from './remote';
import {
  checkedFields,
  focusWand,
  removeProposal,
  renderProposal,
  setProposalNote,
} from './card';
import type { CardOptions } from './card';
import type { LibraryRecord } from '../../../indexedDB/types';
import type { MetadataProposal } from './types';

const FILE = '/components/sourceContainer/autoMetadata/index.ts';

const ENCRYPTED_NOTE =
  "This book is encrypted, so its text can't be sent to the AI. The suggestion above was made entirely in your browser.";

/** The subset of SourceContainerManager this module drives. */
interface PanelHost {
  container: HTMLElement;
  syncLibraryRecordToBackend: (record: LibraryRecord) => Promise<unknown>;
  refreshCitationDisplay: () => Promise<void> | void;
}

function currentUsername(): string | null {
  try {
    return getAuthContextSync()?.user?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * The card renders into #auto-meta-mount, a slot under the citation block — so
 * everything here works off the whole panel rather than the check-source
 * section, and stays correct if the panel's layout moves again.
 */
function panel(self: PanelHost): HTMLElement | null {
  return self.container;
}

async function cardOptions(bookId: string): Promise<CardOptions> {
  if (isBookEncrypted(bookId)) return { aiBlockedReason: ENCRYPTED_NOTE };
  return { byo: await byoActive() };
}

/** Render a proposal with all three handlers bound. */
async function show(self: PanelHost, proposal: MetadataProposal): Promise<void> {
  const host = panel(self);
  if (!host) return;

  renderProposal(host, proposal, await cardOptions(book), {
    onApply: () => void applyAutoMetadata(self, proposal),
    onCancel: () => {
      removeProposal(host);
      focusWand(self.container);
    },
    onEscalate: () => void handleAutoMetadataAi(self, proposal),
  });
}

// ── Tier 1: the free local pass ───────────────────────────────────────────────

export async function handleAutoMetadata(self: PanelHost): Promise<void> {
  const host = panel(self);
  if (!host) return;

  try {
    const db = await openDatabase();
    const record: LibraryRecord | null = await getRecord(db, 'library', book);
    if (!record) {
      log.error('Auto metadata: no library record for this book', FILE, { book });
      return;
    }

    const nodes = await getNodesFromIndexedDB(book);
    const proposal = proposeLocalMetadata(record, nodes, currentUsername());

    log.user('Auto metadata: local pass', FILE, { book, suggested: proposal.fields.length });
    await show(self, proposal);
  } catch (err) {
    log.error('Auto metadata: local pass failed', FILE, err);
  }
}

// ── Tier 2: the paid AI pass ──────────────────────────────────────────────────

export async function handleAutoMetadataAi(self: PanelHost, localProposal?: MetadataProposal): Promise<void> {
  const host = panel(self);
  if (!host) return;

  // Belt and braces — the button is not rendered for encrypted books, but a
  // stale card must never be able to ship their plaintext.
  if (isBookEncrypted(book)) {
    setProposalNote(host, ENCRYPTED_NOTE);
    return;
  }

  const escalate = host.querySelector('#auto-meta-escalate') as HTMLButtonElement | null;
  if (escalate) {
    escalate.disabled = true;
    escalate.textContent = 'Reading the text…';
  }
  setProposalNote(host, 'Reading the text…');

  try {
    const db = await openDatabase();
    const record: LibraryRecord | null = await getRecord(db, 'library', book);
    if (!record) return;

    const nodes = await getNodesFromIndexedDB(book);
    const text = openingPlainText(nodes, AI_NODE_LIMIT, AI_CHAR_LIMIT);
    if (!text.trim()) {
      setProposalNote(host, 'There is no text in this book yet for the AI to read.');
      return;
    }

    const result = await requestAiMetadata(book, text);

    if (!result.ok) {
      // Keep the local card standing — a failed escalation must not throw away
      // the free suggestion the user already has.
      if (result.status === 402) {
        setProposalNote(host, 'Not enough balance to read the text.');
        await offerTopUp('Not enough balance to read the text with AI. Top up $5 to continue?');
      } else if (result.status === 403) {
        setProposalNote(host, result.message || ENCRYPTED_NOTE);
      } else if (result.status === 422) {
        setProposalNote(host, "The AI couldn't find any metadata in this text.");
      } else if (result.status === 503) {
        setProposalNote(host, "Your own AI model didn't respond.");
      } else {
        setProposalNote(host, result.message || 'Could not read the text.');
      }
      if (escalate) {
        escalate.disabled = false;
        escalate.textContent = 'Try reading the text again';
      }
      return;
    }

    const aiProposal = proposeFromAi(record, result.metadata, currentUsername());

    // Anything the AI didn't cover but the local pass did (a copyright year it
    // missed, say) is still worth keeping — merge, AI winning on conflicts.
    const merged: MetadataProposal = {
      tier: 'ai',
      fields: [
        ...aiProposal.fields,
        ...(localProposal?.fields ?? []).filter((f) => !aiProposal.fields.some((a) => a.field === f.field)),
      ],
      notes: aiProposal.notes,
    };

    await show(self, merged);

    const after = panel(self);
    if (after) {
      // `charged` is what actually hit the ledger (raw × tier multiplier),
      // computed server-side — the client deliberately keeps no copy of the
      // tier table to disagree with.
      setProposalNote(
        after,
        result.charged != null
          ? `Read by AI — $${result.charged.toFixed(4)} charged.`
          : 'Read by your own AI — nothing charged.',
      );
    }
  } catch (err) {
    log.error('Auto metadata: AI pass failed', FILE, err);
    setProposalNote(host, 'Something went wrong reading the text.');
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * generateBibtexFromForm filters keys BY TYPE and `misc` allows only
 * author/title/year/url/note — so a journal or publisher written without a
 * matching type would vanish from the bibtex the citation line renders from.
 */
function reconcileType(merged: LibraryRecord): void {
  if (merged.journal) merged.type = 'article';
  else if (merged.publisher && (!merged.type || merged.type === 'misc')) merged.type = 'book';
}

export async function applyAutoMetadata(self: PanelHost, proposal: MetadataProposal): Promise<void> {
  const host = panel(self);
  if (!host) return;

  const ticked = checkedFields(host);
  const chosen = proposal.fields.filter((f) => ticked.has(f.field));
  if (!chosen.length) {
    setProposalNote(host, 'Nothing selected to apply.');
    return;
  }

  try {
    const db = await openDatabase();
    // Re-read rather than trusting the record captured at render time — the
    // pencil form may have run in between.
    const fresh: LibraryRecord | null = await getRecord(db, 'library', book);
    if (!fresh) {
      setProposalNote(host, 'Could not find this book’s library card.');
      return;
    }

    // The never-clobber guarantee has to hold at WRITE time, not just at propose
    // time: drop any row whose starting value has moved under us.
    const applicable = chosen.filter((f) => String((fresh as any)[f.field] ?? '').trim() === f.current);
    if (!applicable.length) {
      setProposalNote(host, 'These details have already changed — nothing was applied.');
      return;
    }

    const patch: Record<string, unknown> = {};
    for (const f of applicable) patch[f.field] = f.suggested;

    const merged = {
      ...fresh,
      ...patch,
      book: fresh.book,
      // A stale timestamp makes DbLibraryController::upsert preserve the OLD
      // bibliographic fields, i.e. the write silently vanishes.
      timestamp: Date.now(),
    } as LibraryRecord;
    reconcileType(merged);
    merged.bibtex = generateBibtexFromForm(merged);

    const cleaned: LibraryRecord = prepareLibraryForIndexedDB(merged);
    const tx = db.transaction('library', 'readwrite');
    tx.objectStore('library').put(cleaned);

    // The user has now chosen a title, so the typing-time first-node sync must
    // stop tracking the heading — otherwise the next edit to node 100 would
    // quietly overwrite what they just confirmed.
    if (applicable.some((f) => f.field === 'title')) forgetAutoDerivedTitle(fresh.book);

    try {
      await self.syncLibraryRecordToBackend(cleaned);
    } catch (syncError) {
      verbose.content('Auto metadata: backend sync failed, local write stands', FILE, syncError);
      setProposalNote(host, "Saved locally — will sync when you're back online.");
    }

    log.user('Auto metadata: applied', FILE, { book, fields: applicable.map((f) => f.field) });

    // Rebuilds the panel from IDB, so the citation line updates, the card is
    // destroyed and attachInternalListeners re-wires both buttons.
    await self.refreshCitationDisplay();
  } catch (err) {
    log.error('Auto metadata: apply failed', FILE, err);
    setProposalNote(host, 'Could not save these details.');
  }
}

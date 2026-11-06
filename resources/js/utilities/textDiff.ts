/**
 * textDiff — tiny word-level LCS diff for the suggested-edit before/after
 * rendering (hyperlitContainer/suggestedEditControl.ts). Zero-import leaf.
 *
 * Tokens are words WITH their trailing whitespace (so joins reconstruct the
 * original strings exactly); the LCS table is word-count sized, which is fine
 * for highlight-length passages (a few hundred words at most).
 */

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

function tokenize(text: string): string[] {
  // A token is a run of non-whitespace plus any whitespace that follows it
  // (leading whitespace rides the first token via the second alternative).
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/** Word-level diff of two plain-text strings. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // LCS length table (n+1 × m+1). Indices are loop-bounded, hence the `!`s.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i]!.trim() === b[j]!.trim()
        ? next[j + 1]! + 1
        : Math.max(next[j]!, row[j + 1]!);
    }
  }

  // Walk the table, coalescing runs of the same type.
  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      parts.push({ type, text });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]!.trim() === b[j]!.trim()) {
      // Emit the AFTER token so reassembling 'same'+'add' yields `after` exactly
      // (whitespace may differ between the two sides of a matching word).
      push('same', b[j]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('del', a[i]!);
      i++;
    } else {
      push('add', b[j]!);
      j++;
    }
  }
  while (i < n) push('del', a[i++]!);
  while (j < m) push('add', b[j++]!);

  return parts;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render diff parts as escaped HTML: <del class="se-del"> / <ins class="se-add"> spans. */
export function renderDiffHtml(parts: DiffPart[]): string {
  return parts
    .map((part) => {
      const text = escapeHtml(part.text);
      if (part.type === 'add') return `<ins class="se-add">${text}</ins>`;
      if (part.type === 'del') return `<del class="se-del">${text}</del>`;
      return text;
    })
    .join('');
}

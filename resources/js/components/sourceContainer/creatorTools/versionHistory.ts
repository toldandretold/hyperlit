// Version-history list (#version-history-list) inside Creator Tools. Pulls
// snapshots via the shared loadSnapshots helper and renders relative-time links
// to the time-machine, with a "Show More" cutoff after 5 entries.
import { book } from '../../../app.js';
import { loadSnapshots } from '../../../conversion/versionRestore.js';
import { formatRelativeTime } from '../helpers';

export async function loadVersionHistory(self: any) {
  const listEl = self.container.querySelector("#version-history-list");
  if (!listEl) return;

  try {
    const snapshots = await loadSnapshots(book);   // shared helper — see conversion/versionRestore.js

    if (!snapshots || snapshots.length === 0) {
      listEl.textContent = 'No version history available yet.';
      return;
    }

    listEl.innerHTML = '';
    for (const snap of snapshots) {
      const a = document.createElement('a');
      a.href = `/${encodeURIComponent(book)}/timemachine?at=${encodeURIComponent(snap.changed_at)}`;
      a.className = 'version-history-item';
      if (snap.is_condensed) a.classList.add('version-history-condensed');

      const timeSpan = document.createElement('span');
      timeSpan.className = 'snapshot-time';
      timeSpan.textContent = formatRelativeTime(snap.changed_at);

      const detailSpan = document.createElement('span');
      detailSpan.className = 'snapshot-detail';
      const nodeLabel = `${snap.nodes_changed} node${snap.nodes_changed == 1 ? '' : 's'}`;
      detailSpan.textContent = snap.is_condensed ? `${nodeLabel} (hourly)` : nodeLabel;

      a.appendChild(timeSpan);
      a.appendChild(detailSpan);
      listEl.appendChild(a);
    }

    const items = listEl.querySelectorAll('.version-history-item');
    if (items.length > 5) {
      for (let i = 5; i < items.length; i++) {
        items[i].style.display = 'none';
      }
      const showMoreBtn = document.createElement('button');
      showMoreBtn.textContent = 'Show More';
      showMoreBtn.className = 'version-history-show-more';
      showMoreBtn.addEventListener('click', () => {
        for (let i = 5; i < items.length; i++) {
          items[i].style.display = '';
        }
        showMoreBtn.remove();
      });
      listEl.appendChild(showMoreBtn);
    }
  } catch (err) {
    console.warn('Failed to load version history:', err);
    listEl.textContent = 'Could not load version history.';
  }
}

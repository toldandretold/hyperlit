// Closed-state inline styles for the #newbook-container panel — applied once at construction
// so the open/close CSS transition has something to animate from (0×0, collapsed, hidden).
// Pure: takes the element, touches nothing else. Was NewBookContainerManager.setupNewBookContainerStyles.

export function setupContainerStyles(container: HTMLElement | null): void {
  if (!container) return;

  // CLOSED state only — animate from 0 → XYZ.
  container.style.position = 'fixed';
  container.style.transition =
    'width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out, top 0.3s ease-out, left 0.3s ease-out, right 0.3s ease-out';
  container.style.zIndex = '1001';
  // backgroundColor handled by CSS using var(--container-glass-bg)
  container.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.2)';
  container.style.borderRadius = '0.75em';

  // Start hidden / collapsed.
  container.style.opacity = '0';
  container.style.padding = '12px';
  container.style.width = '0';
  container.style.height = '0';
}

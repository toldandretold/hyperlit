export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function parseColors(raw) {
  if (raw && raw.trim()) return raw.split(',').map(c => c.trim()).filter(Boolean);
  const style = getComputedStyle(document.documentElement);
  const cols = ['--color-primary', '--color-accent', '--color-secondary']
    .map(k => style.getPropertyValue(k).trim()).filter(Boolean);
  return cols.length ? cols : ['#ff0080', '#00ff41', '#8338ec'];
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function parseColors(raw: any): string[] {
  if (raw && raw.trim()) return raw.split(',').map((c: string) => c.trim()).filter(Boolean);
  const style = getComputedStyle(document.documentElement);
  const cols = ['--color-primary', '--color-accent', '--color-secondary']
    .map(k => style.getPropertyValue(k).trim()).filter(Boolean);
  return cols.length ? cols : ['#ff0080', '#00ff41', '#8338ec'];
}

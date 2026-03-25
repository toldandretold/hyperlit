/**
 * Render bar charts from data-chart tables injected by the backend.
 * Called after each lazy-loaded chunk is parsed, same pattern as KaTeX math rendering.
 */

const COLORS = {
  'Unverified Sources': '#9b59b6',
  'Rejected': '#e74c3c',
  'Unlikely': '#e67e22',
  'Plausible': '#f1c40f',
  'Likely': '#a3d977',
  'Confirmed': '#27ae60',
};

const SHORT_LABELS = {
  'Unverified Sources': 'Unverified',
};

function buildBarChartSvg(data, colors) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const width = 500;
  const height = 220;
  const barAreaTop = 25;
  const barAreaBottom = 185;
  const barMaxHeight = barAreaBottom - barAreaTop;
  const barCount = data.length;
  const barGap = 16;
  const totalBarWidth = width - barGap * (barCount + 1);
  const barWidth = Math.floor(totalBarWidth / barCount);

  const maxCount = Math.max(...data.map(d => d.count), 1);

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.display = 'block';
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
  svg.style.margin = '0.5em 0';

  data.forEach((item, i) => {
    const x = barGap + i * (barWidth + barGap);
    const barHeight = maxCount > 0 ? (item.count / maxCount) * barMaxHeight : 0;
    const y = barAreaBottom - barHeight;
    const color = colors[item.label] || '#888';

    // Bar rect
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(Math.max(barHeight, 0)));
    rect.setAttribute('rx', '3');
    rect.setAttribute('fill', color);
    svg.appendChild(rect);

    // Count label above bar
    const countText = document.createElementNS(svgNS, 'text');
    countText.setAttribute('x', String(x + barWidth / 2));
    countText.setAttribute('y', String(y - 6));
    countText.setAttribute('text-anchor', 'middle');
    countText.setAttribute('fill', '#e0e0e0');
    countText.setAttribute('font-size', '13');
    countText.setAttribute('font-family', 'sans-serif');
    countText.textContent = String(item.count);
    svg.appendChild(countText);

    // Category label below bar
    const label = SHORT_LABELS[item.label] || item.label;
    const labelText = document.createElementNS(svgNS, 'text');
    labelText.setAttribute('x', String(x + barWidth / 2));
    labelText.setAttribute('y', String(barAreaBottom + 16));
    labelText.setAttribute('text-anchor', 'middle');
    labelText.setAttribute('fill', '#e0e0e0');
    labelText.setAttribute('font-size', '11');
    labelText.setAttribute('font-family', 'sans-serif');
    labelText.textContent = label;
    svg.appendChild(labelText);
  });

  return svg;
}

export function renderCharts(container) {
  const tables = container.querySelectorAll('table[data-chart="verdict-summary"]');
  tables.forEach(table => {
    const rows = table.querySelectorAll('tbody tr');
    const data = Array.from(rows).map(row => {
      const cells = row.querySelectorAll('td');
      return {
        label: cells[0]?.textContent?.trim() || '',
        count: parseInt(cells[1]?.textContent?.trim(), 10) || 0,
      };
    });

    const svg = buildBarChartSvg(data, COLORS);
    table.replaceWith(svg);
  });
}

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
  svg.style.display = 'block';
  svg.style.width = '100%';
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

const DONUT_COLORS = {
  'Source Found': '#27ae60',
  'Source Not Found': '#9b59b6',
};

function buildDonutChartSvg(data, colors) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const width = 300;
  const donutCx = width / 2;
  const donutCy = 110;
  const outerR = 90;
  const innerR = 58;
  const legendRowHeight = 22;
  const legendTop = donutCy + outerR + 25;
  const height = legendTop + data.length * legendRowHeight + 10;

  const total = data.reduce((s, d) => s + d.count, 0);

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.maxWidth = '400px';
  svg.style.height = 'auto';
  svg.style.margin = '0.5em auto';

  if (total === 0) {
    // Empty state — grey ring
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(donutCx));
    circle.setAttribute('cy', String(donutCy));
    circle.setAttribute('r', String(outerR));
    circle.setAttribute('fill', '#444');
    svg.appendChild(circle);
    const inner = document.createElementNS(svgNS, 'circle');
    inner.setAttribute('cx', String(donutCx));
    inner.setAttribute('cy', String(donutCy));
    inner.setAttribute('r', String(innerR));
    inner.setAttribute('fill', 'transparent');
    svg.appendChild(inner);
    return svg;
  }

  // Draw segments
  let startAngle = -Math.PI / 2;
  data.forEach(item => {
    if (item.count === 0) return;
    const fraction = item.count / total;
    const endAngle = startAngle + fraction * 2 * Math.PI;
    const color = colors[item.label] || '#888';

    // For a full circle (single segment), use two arcs
    if (fraction >= 1) {
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', String(donutCx));
      circle.setAttribute('cy', String(donutCy));
      circle.setAttribute('r', String(outerR));
      circle.setAttribute('fill', color);
      svg.appendChild(circle);
    } else {
      const largeArc = fraction > 0.5 ? 1 : 0;
      const x1 = donutCx + outerR * Math.cos(startAngle);
      const y1 = donutCy + outerR * Math.sin(startAngle);
      const x2 = donutCx + outerR * Math.cos(endAngle);
      const y2 = donutCy + outerR * Math.sin(endAngle);
      const ix1 = donutCx + innerR * Math.cos(startAngle);
      const iy1 = donutCy + innerR * Math.sin(startAngle);
      const ix2 = donutCx + innerR * Math.cos(endAngle);
      const iy2 = donutCy + innerR * Math.sin(endAngle);

      const d = [
        `M ${x1} ${y1}`,
        `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${ix2} ${iy2}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix1} ${iy1}`,
        'Z',
      ].join(' ');

      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', color);
      svg.appendChild(path);
    }

    startAngle = endAngle;
  });

  // Inner circle (donut hole) — transparent to show parent background
  const hole = document.createElementNS(svgNS, 'circle');
  hole.setAttribute('cx', String(donutCx));
  hole.setAttribute('cy', String(donutCy));
  hole.setAttribute('r', String(innerR));
  hole.setAttribute('fill', 'var(--bg-color, #1a1a2e)');
  svg.appendChild(hole);

  // Centre text
  const centreText = document.createElementNS(svgNS, 'text');
  centreText.setAttribute('x', String(donutCx));
  centreText.setAttribute('y', String(donutCy + 7));
  centreText.setAttribute('text-anchor', 'middle');
  centreText.setAttribute('fill', '#e0e0e0');
  centreText.setAttribute('font-size', '22');
  centreText.setAttribute('font-family', 'sans-serif');
  centreText.setAttribute('font-weight', 'bold');
  centreText.textContent = `${data[0]?.count ?? 0}/${total}`;
  svg.appendChild(centreText);

  // Legend below donut — stacked vertically
  data.forEach((item, i) => {
    const color = colors[item.label] || '#888';
    const rowY = legendTop + i * legendRowHeight;

    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', '20');
    dot.setAttribute('cy', String(rowY));
    dot.setAttribute('r', '6');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', '32');
    label.setAttribute('y', String(rowY + 5));
    label.setAttribute('fill', '#e0e0e0');
    label.setAttribute('font-size', '14');
    label.setAttribute('font-family', 'sans-serif');
    label.textContent = `${item.label} (${item.count})`;
    svg.appendChild(label);
  });

  return svg;
}

export function renderCharts(container) {
  // Verdict bar charts
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

  // Source coverage donut charts
  const coverageTables = container.querySelectorAll('table[data-chart="source-coverage"]');
  coverageTables.forEach(table => {
    const rows = table.querySelectorAll('tbody tr');
    const data = Array.from(rows).map(row => {
      const cells = row.querySelectorAll('td');
      return {
        label: cells[0]?.textContent?.trim() || '',
        count: parseInt(cells[1]?.textContent?.trim(), 10) || 0,
      };
    });

    const svg = buildDonutChartSvg(data, DONUT_COLORS);
    table.replaceWith(svg);
  });
}

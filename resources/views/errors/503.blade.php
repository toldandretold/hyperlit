<!DOCTYPE html>
{{-- Maintenance (503) page. Served by `php artisan down --render=errors::503`
     (deploy/deploy.sh --maintenance). MUST stay fully self-contained: during a
     maintenance window the Vite build may be mid-rebuild, so no @vite, no
     external assets — the logo SVG is inlined from home.blade.php and the
     lava-lamp background is a trimmed vanilla-JS port of
     resources/js/components/homepage/lavaLampBackground.ts (no scroll rise,
     no ceiling, no Shift+L adjuster). The meta refresh makes visitors'
     browsers recover on their own once the site is back up. --}}
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="60">
  <title>Hyperlit — down for maintenance</title>
  <style>
    :root {
      --hyperlit-pink: #EE4A95;
      --hyperlit-orange: #EF8D34;
      --hyperlit-aqua: #4EACAE;
      --logo-text-color: #f1f2f2;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      background: #221F20;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #f1f2f2;
      overflow: hidden;
    }
    #lava-mount {
      position: fixed;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      pointer-events: none;
    }
    #lava-mount svg { width: 100%; height: 100%; display: block; }
    .maintenance-wrap {
      position: relative;
      z-index: 1;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .maintenance-card {
      background-color: rgba(34, 31, 32, 0.35);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(241, 242, 242, 0.12);
      border-radius: 18px;
      padding: clamp(28px, 5vw, 56px);
      max-width: 560px;
      width: 100%;
      text-align: center;
    }
    .maintenance-card .logo { width: min(320px, 80%); height: auto; margin: 0 auto 1.6em; display: block; }
    .maintenance-card p {
      font-size: clamp(1.05rem, 2.4vw, 1.3rem);
      line-height: 1.55;
      text-wrap: balance;
    }
    .maintenance-card a {
      color: var(--hyperlit-aqua);
      text-decoration: none;
      border-bottom: 1px solid var(--hyperlit-pink);
    }
    .maintenance-card a:hover { color: var(--hyperlit-pink); }
  </style>
</head>
<body>

<div id="lava-mount" aria-hidden="true"></div>

<div class="maintenance-wrap">
  <div class="maintenance-card">
    <svg class="logo" role="img" aria-label="Hyperlit" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432.49 110.22">
      <defs>
        <linearGradient id="mg1" x1="14.17" y1="28.33" x2="14.17" y2="0" gradientTransform="translate(28.33 28.33) rotate(-180)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ff8700"/>
          <stop offset="1" stop-color="#00afaf"/>
        </linearGradient>
        <linearGradient id="mg2" x1="-169.77" y1="-.18" x2="-169.77" y2="82.14" gradientTransform="translate(183.94)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ee4b96"/>
          <stop offset=".33" stop-color="#00afaf"/>
          <stop offset=".66" stop-color="#ff8700"/>
          <stop offset="1" stop-color="#ee4b96"/>
        </linearGradient>
      </defs>
      <polygon points="112.41 35.83 67.35 35.83 67.35 .21 56.32 .21 56.32 85.01 67.35 85.01 67.35 45.15 112.41 45.15 112.41 85.01 123.44 85.01 123.44 .21 112.41 .21 112.41 35.83" fill="var(--logo-text-color, #f1f2f2)"/>
      <path d="M162.38,63.93c-.32.81-.55,1.39-.67,1.76-.12.36-.35.95-.67,1.76-.25.81-.44,1.41-.6,1.82-.17.4-.36,1.01-.61,1.82-.89-2.42-1.81-4.8-2.79-7.15l-14.54-37.32h-11.51l23.38,56.34-10.66,27.26h11.03l31.38-83.6h-10.91l-12.84,37.32Z" fill="var(--logo-text-color, #f1f2f2)"/>
      <path d="M236.4,28.68c-4.07-2.66-8.86-4-14.36-4-4.12,0-7.92.97-11.39,2.91-3.48,1.94-6.1,4.28-7.88,7.03v-8h-10.42v83.6h10.42v-33.32c1.94,3.07,4.56,5.49,7.88,7.27,3.31,1.78,7.03,2.67,11.15,2.67,5.33,0,10.05-1.31,14.17-3.94,4.12-2.62,7.31-6.28,9.57-10.97,2.26-4.68,3.4-10.1,3.4-16.23s-1.07-11.31-3.21-15.99c-2.14-4.68-5.25-8.36-9.33-11.02ZM235.86,67.69c-1.45,3.47-3.53,6.18-6.24,8.12-2.71,1.94-5.84,2.91-9.39,2.91s-6.69-.97-9.39-2.91c-2.71-1.94-4.83-4.64-6.36-8.12-1.54-3.47-2.3-7.47-2.3-11.99s.76-8.62,2.3-12.06c1.53-3.43,3.67-6.08,6.42-7.94,2.75-1.86,5.86-2.79,9.33-2.79s6.69.97,9.39,2.91c2.71,1.94,4.79,4.62,6.24,8.06,1.45,3.43,2.18,7.37,2.18,11.81s-.72,8.52-2.18,11.99Z" fill="var(--logo-text-color, #f1f2f2)"/>
      <path d="M297.86,28.49c-4.04-2.54-8.92-3.82-14.66-3.82-5.25,0-10,1.33-14.24,4-4.24,2.67-7.56,6.34-9.93,11.02-2.39,4.69-3.58,9.98-3.58,15.87,0,6.63,1.15,12.28,3.45,16.96,2.3,4.68,5.57,8.24,9.81,10.66,4.24,2.42,9.27,3.64,15.09,3.64,5.25,0,9.75-.91,13.51-2.73,3.76-1.82,6.65-4.22,8.66-7.21,2.02-2.99,3.23-6.3,3.64-9.93h-10.3c-.65,4.2-2.38,7.21-5.21,9.02-2.83,1.82-6.22,2.73-10.18,2.73-3.39,0-6.44-.83-9.15-2.48-2.71-1.65-4.84-4.06-6.42-7.21-1.57-3.15-2.4-6.9-2.48-11.27h44.34v-2.06c0-6.3-1.05-11.77-3.15-16.42-2.1-4.64-5.17-8.24-9.21-10.78ZM266.24,50.36c.4-5.01,2.14-9.17,5.21-12.48,3.07-3.31,6.98-4.97,11.75-4.97,5,0,8.9,1.58,11.69,4.72,2.79,3.15,4.18,7.39,4.18,12.72h-32.83Z" fill="var(--logo-text-color, #f1f2f2)"/>
      <path d="M337.52,27.89c-3.19,2.14-5.56,4.95-7.09,8.42v-9.69h-10.42v58.4h10.42v-30.89c0-4.28.68-7.85,2.06-10.72,1.37-2.87,3.37-5.01,6-6.42,2.62-1.41,5.84-2.12,9.63-2.12,1.05,0,2.14.08,3.27.24v-10.3c-.65-.08-1.54-.12-2.67-.12-4.28,0-8.02,1.07-11.2,3.21Z" fill="var(--logo-text-color, #f1f2f2)"/>
      <polygon points="357.73 .21 357.73 8.81 357.73 76.41 357.73 85.01 368.16 85.01 368.16 76.41 368.16 .21 362.95 .21 357.73 .21" fill="var(--logo-text-color, #f1f2f2)"/>
      <rect x="380.16" y="3.11" width="12.12" height="12.48" fill="var(--logo-text-color, #f1f2f2)"/>
      <polygon points="381.13 26.62 381.13 35.22 381.13 76.41 381.13 85.01 391.55 85.01 391.55 76.41 391.55 26.62 386.34 26.62 381.13 26.62" fill="var(--logo-text-color, #f1f2f2)"/>
      <path d="M428.12,76.65c-2.75,0-4.87-.68-6.36-2.06s-2.24-3.68-2.24-6.91v-32.47h12.12v-8.6h-12.12V7.35h-10.42v19.26h-10.91v8.6h10.91v33.56c0,6.06,1.55,10.44,4.66,13.15,3.11,2.71,7.09,4.06,11.93,4.06,1.21,0,2.38-.06,3.52-.18,1.13-.12,2.22-.3,3.27-.54v-8.96c-1.7.24-3.15.36-4.37.36Z" fill="var(--logo-text-color, #f1f2f2)"/>
      <rect width="28.33" height="28.33" transform="translate(28.33 28.33) rotate(180)" fill="url(#mg1)"/>
      <rect y="56.67" width="28.33" height="28.33" fill="url(#mg2)"/>
    </svg>
    <p>Apologies comrades. Site is down for maintenance. Email any concerns to <a href="mailto:fml@hyperlit.io">fml&#64;hyperlit.io</a></p>
  </div>
</div>

<script>
(function () {
  'use strict';
  // Trimmed port of lavaLampBackground.ts (rise/ceiling/adjuster removed).
  var CFG = {
    seed: 5, wobble: 0.015, scatterMul: 1.0,
    pinkHold: 0.05, orangePos: 0.6, aquaPos: 0.20, phase: 0.40,
    animSpeed: 1.0, animAmt: 0.6,
    clusters: [
      { x: 1040, H: 900, W: 210, n: 10, stepDown: 0.06, stepX: 26,  scatter: 30 },
      { x: 860,  H: 320, W: 250, n: 7,  stepDown: 0.02, stepX: -10, scatter: 120 },
      { x: 470,  H: 470, W: 430, n: 9,  stepDown: 0.07, stepX: 30,  scatter: 40 },
      { x: 1390, H: 430, W: 340, n: 6,  stepDown: 0.05, stepX: -25, scatter: 50 },
      { x: 1720, H: 690, W: 520, n: 10, stepDown: 0.06, stepX: -40, scatter: 60 },
      { x: 280,  H: 165, W: 480, n: 7,  stepDown: 0.03, stepX: 18,  scatter: 150 },
      { x: 1080, H: 130, W: 440, n: 6,  stepDown: 0.03, stepX: -15, scatter: 160 }
    ]
  };
  var BASE_Y = 1001, VW = 1600, VH = 1000, BASE_BLUSH = '#F0A9C9';
  var simT = 0;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    CFG.animSpeed *= 0.5; CFG.animAmt *= 0.4; // gentle mode, same as the TS component
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function domePath(rng, cx, rx, ry, wobble) {
    var lean = (rng() - 0.5) * 0.20;
    var terms = [
      [wobble * (0.6 + rng() * 0.6), 3 + rng() * 4, rng() * 6.283],
      [wobble * (0.3 + rng() * 0.4), 7 + rng() * 6, rng() * 6.283]
    ];
    var pts = [], N = 40, i, th, nz, w, x, y;
    for (i = 0; i <= N; i++) {
      th = (Math.PI * i) / N;
      nz = 0;
      for (var j = 0; j < terms.length; j++) nz += terms[j][0] * Math.sin(terms[j][1] * th + terms[j][2]);
      w = 1 + nz * Math.sqrt(Math.sin(th));
      x = cx - rx * Math.cos(th) * w + lean * rx * Math.sin(th);
      y = Math.min(BASE_Y, BASE_Y - ry * Math.sin(th) * w);
      pts.push([x, y]);
    }
    function at(k) { return pts[clamp(k, 0, pts.length - 1)]; }
    var d = 'M ' + at(0)[0].toFixed(0) + ' ' + at(0)[1].toFixed(0) + ' ';
    for (i = 0; i < pts.length - 1; i++) {
      var p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      d += 'C ' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(0) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(0)
        + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(0) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(0)
        + ' ' + p2[0].toFixed(0) + ' ' + p2[1].toFixed(0) + ' ';
    }
    return d + 'Z';
  }

  function gradStops(rng, damp) {
    var ph = CFG.phase * (damp ? 0.4 : 1);
    function shift() { return (rng() - 0.5) * 2 * ph; }
    var pink = clamp(CFG.pinkHold + shift() * 0.6, 0.0, 0.45);
    var orange = clamp(CFG.orangePos + shift(), pink + 0.08, 0.85);
    var aqua = clamp(CFG.aquaPos + shift() * 0.7, orange + 0.08, 0.985);
    return { pink: pink, orange: orange, aqua: aqua };
  }

  function animCluster(c, ci) {
    var k = CFG.animAmt;
    if (simT === 0 || k === 0) return c;
    var per = 24 + (((ci * 9301 + 49297) % 233) / 233) * 26;
    var ph = ci * 1.7;
    var e = Math.sin((simT * 2 * Math.PI) / per + ph);
    var sway = Math.sin((simT * 2 * Math.PI) / (per * 1.9) + ph * 2.3);
    return {
      x: c.x + sway * 90 * k, H: c.H * (1 + e * 0.55 * k), W: c.W * (1 - e * 0.45 * k),
      n: c.n, stepDown: c.stepDown, stepX: c.stepX * (1 + sway * 0.4 * k), scatter: c.scatter
    };
  }

  function buildBlobs() {
    var blobs = [], k = CFG.animAmt;
    CFG.clusters.forEach(function (cBase, ci) {
      var c = animCluster(cBase, ci);
      var rng = mulberry32(CFG.seed * 7919 + ci * 1013);
      for (var i = 0; i < c.n; i++) {
        var ry = c.H * Math.pow(1 - c.stepDown, i) * (1 + (rng() - 0.5) * 0.10);
        var rx = c.W * Math.pow(ry / c.H, 0.75) * (1 + (rng() - 0.5) * 0.20);
        var x = c.x + c.stepX * i + (rng() - 0.5) * 2 * c.scatter;
        var g = gradStops(rng, false);
        blobs.push({ d: domePath(rng, x, rx, ry, CFG.wobble), pink: g.pink, orange: g.orange, aqua: g.aqua });
      }
    });
    function bobX(i) { return simT ? Math.sin(simT * 0.15 + i * 1.9) * 30 * k : 0; }
    function bobY(i) { return simT ? 1 + 0.08 * k * Math.sin(simT * 0.21 + i * 2.7) : 1; }
    var sRng = mulberry32(CFG.seed * 104729 + 17);
    var mid = Math.round(8 * CFG.scatterMul), front = Math.round(12 * CFG.scatterMul), tiny = Math.round(9 * CFG.scatterMul);
    var mids = [], i, ry, rx, g;
    for (i = 0; i < mid; i++) {
      ry = (140 + sRng() * 180) * bobY(i);
      rx = ry * (1.3 + sRng() * 1.9);
      g = gradStops(sRng, true);
      mids.push({ d: domePath(sRng, 560 + sRng() * 390 + bobX(i), rx, ry, CFG.wobble), pink: g.pink, orange: g.orange, aqua: g.aqua });
    }
    var firstN = CFG.clusters[0] ? CFG.clusters[0].n : 0;
    Array.prototype.splice.apply(blobs, [firstN, 0].concat(mids));
    for (i = 0; i < front; i++) {
      ry = (70 + sRng() * 130) * bobY(i + 40);
      rx = ry * (1.3 + sRng() * 1.9);
      g = gradStops(sRng, true);
      blobs.push({ d: domePath(sRng, -80 + sRng() * 1780 + bobX(i + 40), rx, ry, CFG.wobble), pink: g.pink, orange: g.orange, aqua: g.aqua });
    }
    for (i = 0; i < tiny; i++) {
      ry = (45 + sRng() * 65) * bobY(i + 80);
      rx = ry * (1.3 + sRng() * 1.9);
      g = gradStops(sRng, true);
      blobs.push({ d: domePath(sRng, -80 + sRng() * 1780 + bobX(i + 80), rx, ry, CFG.wobble), pink: g.pink, orange: g.orange, aqua: g.aqua });
    }
    return blobs;
  }

  var mount = document.getElementById('lava-mount');
  var pathEls = [];

  function renderFull() {
    var blobs = buildBlobs(), defs = '', paths = '';
    blobs.forEach(function (b, i) {
      defs += '<linearGradient id="lava-g' + i + '" x1="0" y1="0" x2="0" y2="1">'
        + '<stop offset="0" stop-color="var(--hyperlit-pink)"/>'
        + (b.pink > 0.01 ? '<stop offset="' + b.pink.toFixed(2) + '" stop-color="var(--hyperlit-pink)"/>' : '')
        + '<stop offset="' + b.orange.toFixed(2) + '" stop-color="var(--hyperlit-orange)"/>'
        + '<stop offset="' + b.aqua.toFixed(2) + '" stop-color="var(--hyperlit-aqua)"/>'
        + '<stop offset="1" stop-color="' + BASE_BLUSH + '"/>'
        + '</linearGradient>';
      paths += '<path d="' + b.d + '" fill="url(#lava-g' + i + ')"/>';
    });
    mount.innerHTML = '<svg viewBox="0 0 ' + VW + ' ' + VH + '" preserveAspectRatio="xMidYMax slice"><defs>' + defs + '</defs>' + paths + '</svg>';
    pathEls = Array.prototype.slice.call(mount.querySelectorAll('path'));
  }

  renderFull();

  var lastNow = performance.now(), lastFrame = 0;
  function loop(now) {
    simT += ((now - lastNow) / 1000) * CFG.animSpeed;
    lastNow = now;
    if (now - lastFrame > 33) {
      lastFrame = now;
      var blobs = buildBlobs();
      for (var i = 0; i < blobs.length && i < pathEls.length; i++) pathEls[i].setAttribute('d', blobs[i].d);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
</script>

</body>
</html>

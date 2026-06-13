# resize-doctor

Paste the block below into the Safari console **while the resize edge won't drag**.

It avoids `getEventListeners` (Safari lacks it). After running, press the resize edge
once — the click probe reports what actually happens. Helpers: `__fixResize()` clears
stuck state, `__disarm()` stops the click probe.

```js
(() => {
  const L = (...a) => console.log('%c[resize-doctor]','color:#e67e22;font-weight:bold',...a);
  const D = window.containerDragger;

  L('=== DRAGGER STATE ===');
  if (!D) L('MISSING window.containerDragger — module never loaded / was wiped');
  else {
    L('isResizing:', D.isResizing, '| dir:', D.resizeDirection, '| type:', D.containerType);
    L('currentContainer:', D.currentContainer, '| connected:', D.currentContainer && D.currentContainer.isConnected);
    if (D.isResizing) L('STUCK isResizing=true while idle — a prior drag never ended. Run __fixResize().');
    if (D.currentContainer && !D.currentContainer.isConnected) L('currentContainer is DETACHED (SPA-nav swapped it mid-drag). Run __fixResize().');
  }

  L('=== BODY CLASSES ===');
  var rz = document.body.classList.contains('container-resizing');
  var dg = document.body.classList.contains('container-dragging');
  L('container-resizing:', rz, '| container-dragging:', dg);
  if (rz || dg) L('STUCK BODY CLASS -> pointer-events:none on whole page except resize-edge/controls. Run __fixResize().');

  L('=== HANDLES ===');
  var handles = Array.prototype.slice.call(document.querySelectorAll('.resize-edge.resize-left, .resize-handle'));
  L('found', handles.length, 'handle(s)');
  if (handles.filter(function(h){ return h.matches('.resize-edge.resize-left'); }).length > 1)
    L('multiple left-edge handles (stacked layers) — only the topmost at a given point is grabbable.');

  handles.forEach(function(h, i) {
    var r = h.getBoundingClientRect();
    var cs = getComputedStyle(h);
    var cx = r.left + r.width/2, cy = r.top + r.height/2;
    var hit = document.elementFromPoint(cx, cy);
    var hitH = hit && hit.closest ? hit.closest('.resize-edge, .resize-handle') : null;
    var cont = h.closest('#hyperlit-container, #toc-container, .hyperlit-container-stacked');
    L('handle[' + i + '] ' + h.className, {
      connected: h.isConnected,
      rect: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      pointerEvents: cs.pointerEvents, display: cs.display, visibility: cs.visibility,
      zIndex: cs.zIndex, opacity: cs.opacity
    });
    if (r.width === 0 || r.height === 0) L('   FAIL handle[' + i + '] ZERO size — ungrabbable.');
    if (cs.pointerEvents === 'none')     L('   FAIL handle[' + i + '] pointer-events:none — clicks pass through.');
    if (!cont)                           L('   FAIL handle[' + i + '] NOT inside a recognised container -> startResize() bails (drag.js:79).');
    if (hitH !== h) L('   FAIL handle[' + i + '] is COVERED. elementFromPoint(center) ->', hit, '— THIS element is eating your mousedown.');
    else            L('   OK handle[' + i + '] is the topmost element at its center — clicks should reach it.');
  });

  L('=== CLICK PROBE ARMED ===  now press the resize edge once');
  var probe = function(e) {
    var t = e.target;
    var rh = t && t.closest ? t.closest('.resize-handle, .resize-edge') : null;
    L('pointer hit:', t, '| closest handle:', rh, '| would startResize:', !!rh);
    if (rh) {
      var c = rh.closest('#hyperlit-container, #toc-container, .hyperlit-container-stacked');
      L('   -> container:', c, c ? '(resize WILL start)' : '(FAIL bails — no container)');
    }
  };
  document.addEventListener('mousedown', probe, true);
  document.addEventListener('touchstart', probe, true);
  window.__disarm = function() {
    document.removeEventListener('mousedown', probe, true);
    document.removeEventListener('touchstart', probe, true);
    L('probe disarmed');
  };

  window.__fixResize = function() {
    document.body.classList.remove('container-resizing','container-dragging');
    Array.prototype.slice.call(document.querySelectorAll('.resizing')).forEach(function(el){ el.classList.remove('resizing'); });
    if (D) { D.isResizing=false; D.resizeDirection=null; D.currentContainer=null; D.containerType=null; }
    L('force-reset done — try dragging now.');
  };
  L('Helpers: __fixResize()  (clear stuck state)   __disarm()  (stop the click probe)');
})();
```

## How to read it

- **Any `STUCK`** (isResizing / detached container / body class) -> state-leak theory.
  Run `__fixResize()` then try dragging. If that fixes it, the bug is a missing
  `reset()` on some interruption path (SPA nav or mouse-up-outside-window).
- **A handle shows `FAIL ... COVERED`** with `elementFromPoint` returning some *other*
  element -> overlap theory; that element is the culprit (stack overlay, toc-container,
  vibe-animation layer, etc.).
- **Click probe says `would startResize: false`** even though you pressed the strip ->
  the mousedown isn't reaching `.resize-edge` (covered / pointer-events). If it says
  `true` but `container: FAIL bails` -> the handle got orphaned from its container
  (post-nav DOM swap).

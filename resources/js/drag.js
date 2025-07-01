// IDs of the panels we want to make draggable
const PANEL_IDS = [
  "ref-container",
  "highlight-container",
  "hypercite-container",
];

function makeDraggable(panel) {
  let offsetX, offsetY, isDragging = false;

  panel.addEventListener("mousedown", (e) => {
    isDragging = true;
    panel.classList.add("dragging");
    // If panel was using `right`, drop that so `left` takes over
    panel.style.right = "auto";
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    panel.style.left = `${e.clientX - offsetX}px`;
    panel.style.top  = `${e.clientY - offsetY}px`;
  }

  function onMouseUp() {
    isDragging = false;
    panel.classList.remove("dragging");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }
}

// Wait for DOM, then attach to each panel
document.addEventListener("DOMContentLoaded", () => {
  for (const id of PANEL_IDS) {
    const panel = document.getElementById(id);
    if (panel) makeDraggable(panel);
  }
});
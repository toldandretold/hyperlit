/**
 * Modal Manager
 *
 * Manages paste operation UI modals (conversion progress, markdown progress).
 */

// Create the modal but don't append yet
const conversionModal = document.createElement("div");
conversionModal.id = "conversion-modal";
conversionModal.style.cssText = `
  position: fixed;
  inset: 0;                 /* shorthand for top/right/bottom/left:0 */
  display: none;
  align-items: center;
  justify-content: center;
  background: #221F20;
  z-index: 9999;
  color: #221F20;
`;
conversionModal.innerHTML = `
  <div style="
    background: #CBCCCC;
    padding: 1em 2em;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    font: 16px sans-serif;
  ">
    <p id="conversion-message" style="margin:0">
      Converting…
    </p>
  </div>
`;

// Once DOMContentLoaded, append it exactly once
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(conversionModal);
  });
} else {
  document.body.appendChild(conversionModal);
}

/**
 * Show conversion modal with message
 * @param {string} message - Message to display
 */
export async function showConversionModal(message) {
  conversionModal.querySelector("#conversion-message").textContent = message;
  conversionModal.style.display = "flex";
  // wait two frames to be sure it painted
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

/**
 * Hide conversion modal
 */
export function hideConversionModal() {
  conversionModal.style.display = "none";
}

/**
 * REMOVED: showProgressModal()
 *
 * Markdown conversion now uses ProgressOverlayConductor for consistent UX.
 * This function has been replaced with the unified progress overlay system.
 *
 * See: resources/js/navigation/ProgressOverlayConductor.js
 */

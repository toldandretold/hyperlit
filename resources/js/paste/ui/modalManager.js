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
 * Show progress modal for markdown conversion
 * @returns {Object} - Modal controller with update/complete methods
 */
export async function showProgressModal() {
  const modal = document.createElement("div");
  modal.className = "progress-modal";

  modal.innerHTML = `
    <div class="progress-modal-content">
      <p class="progress-text">Converting Markdown...</p>
      <div class="progress-bar-container">
        <div class="progress-bar"></div>
      </div>
      <p class="progress-details">Preparing...</p>
    </div>
  `;

  document.body.appendChild(modal);

  const bar = modal.querySelector('.progress-bar');
  const text = modal.querySelector('.progress-text');
  const details = modal.querySelector('.progress-details');

  return {
    modal,
    updateProgress: (percent, current, total) => {
      bar.style.width = percent + '%';
      text.textContent = `Converting Markdown... ${Math.round(percent)}%`;
      details.textContent = `Processing chunk ${current} of ${total}`;
    },
    complete: () => {
      bar.style.width = '100%';
      text.textContent = 'Conversion Complete!';
      details.textContent = 'Finalizing...';
      setTimeout(() => modal.remove(), 500);
    }
  };
}

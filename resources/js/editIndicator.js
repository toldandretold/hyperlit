/**
 * Removes any status icon (spinner or tick) from the global area.
 */
export function removeStatusIcon() {
  const icon = document.querySelector("#status-icon");
  if (icon) {
    icon.parentNode.removeChild(icon);
  }
}

/**
 * Add a spinner icon fixed at the top-right of the screen.
 * @param {HTMLElement} container - Ignored in this global approach.
 */
export function showSpinner() {
  // Only show spinner if in edit mode
  if (!window.isEditing) {
    console.log("Attempted to show spinner while not in edit mode");
    return;
  }
  
  removeStatusIcon();
  
  const spinner = document.createElement("span");
  spinner.id = "status-icon";
  spinner.classList.add("spinner");
  spinner.innerHTML = "&#8635;"; // Unicode for spinner
  
  spinner.style.position = "fixed";
  spinner.style.top = "5px";
  spinner.style.right = "5px";
  spinner.style.fontSize = "16px";
  spinner.style.zIndex = "10000";
  spinner.style.pointerEvents = "none";
  
  document.body.appendChild(spinner);
  console.log("Spinner appended:", spinner);
}


/**
 * Replace the spinner with a tick icon, fixed at the top-right of the screen.
 * @param {HTMLElement} container - Ignored in this global approach.
 */
export function showTick() {
  removeStatusIcon();
  const tick = document.createElement("span");
  tick.id = "status-icon";
  tick.classList.add("tick");
  tick.innerHTML = "&#10004;"; // Unicode checkmark

  // For a global tick, we attach it to document.body with a fixed position.
  tick.style.position = "fixed";
  tick.style.top = "5px";
  tick.style.right = "5px";
  tick.style.fontSize = "16px";
  tick.style.zIndex = "10000";
  tick.style.pointerEvents = "none";

  document.body.appendChild(tick);
  console.log("Tick appended:", tick);

  // After 1 second, remove the tick.
  setTimeout(() => {
    if (tick.parentNode) {
      tick.parentNode.removeChild(tick);
      console.log("Tick removed after 1 second");
    }
  }, 1000);
}

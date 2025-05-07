// editIndicator.js

let spinnerActive = false;
let updateInProgress = false;

export function removeStatusIcon() {
  const icon = document.getElementById("status-icon");
  if (icon) {
    icon.remove();
  }
  // Reset both flags so next showSpinner or showTick can run
  spinnerActive    = false;
  updateInProgress = false;
}

export function showSpinner() {

  // Only one spinner at a time
  if (spinnerActive) return;
  // Remove any leftover tick or spinner
  removeStatusIcon();

  const spinner = document.createElement("span");
  spinner.id = "status-icon";
  spinner.classList.add("spinner");
  spinner.innerHTML = "&#8635;"; // 🔄
  Object.assign(spinner.style, {
    position:      "fixed",
    top:           "5px",
    right:         "5px",
    fontSize:      "16px",
    zIndex:        "10000",
    pointerEvents: "none",
    animation:     "spin 1s linear infinite"
  });
  document.body.appendChild(spinner);

  spinnerActive = true;
  console.log("Spinner appended");
}

export function showTick() {
  // Prevent overlapping animations
  if (updateInProgress) return;
  updateInProgress = true;

  // Remove the spinner (and clear its flag)
  removeStatusIcon();

  const tick = document.createElement("span");
  tick.id = "status-icon";
  tick.classList.add("tick");
  tick.innerHTML = "&#10004;"; // ✔
  Object.assign(tick.style, {
    position:      "fixed",
    top:           "5px",
    right:         "5px",
    fontSize:      "16px",
    zIndex:        "10000",
    pointerEvents: "none"
  });
  document.body.appendChild(tick);
  console.log("Tick appended");

  setTimeout(() => {
    if (tick.parentNode) tick.remove();
    console.log("Tick removed");
    // Allow next showSpinner/showTick
    updateInProgress = false;
  }, 1000);
}

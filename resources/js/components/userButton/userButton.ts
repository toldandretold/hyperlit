// The #userButton trigger: ButtonRegistry lifecycle for the user-auth feature.
// Creates / rebinds the singleton UserContainerManager (whose base
// ContainerManager wires the #userButton click → toggleContainer). The panel +
// all auth logic live in ../userContainer; this module is the thin button-side
// entry point, registered as the 'userContainer' component in
// registerComponents.js. Default export is the manager singleton (consumed by
// editButton.js).
import { UserContainerManager } from "../userContainer/index";
import { verbose } from "../../utilities/logger.js";

// Container manager instance
let userManager: any = null;

export function initializeUserContainer() {
  if (document.getElementById("userButton")) {
    if (!userManager) {
      userManager = new UserContainerManager(
        "user-container",
        "user-overlay",
        "userButton",
        ["main-content"]
      );
      verbose.init('User container manager created', '/components/userButton/userButton.ts');
    } else {
      userManager.button = document.getElementById("userButton");
      userManager.rebindElements();
      userManager.updateButtonColor();
      verbose.init('User container manager updated', '/components/userButton/userButton.ts');
    }
    return userManager;
  } else {
    verbose.init('User container button not found', '/components/userButton/userButton.ts');
    return null;
  }
}

// Auto-initialize if button exists on initial load
if (document.getElementById("userButton")) {
  userManager = initializeUserContainer();
}

export function destroyUserContainer() {
  if (userManager) {
    if (userManager.isOpen) {
      userManager.closeContainer();
    }
    userManager.destroy();
    userManager = null;
    return true;
  }
  return false;
}

export default userManager;

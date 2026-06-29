// The typed surface of NewBookContainerManager that the extracted helper modules
// (animation / geometry / buttonView / openClose / importForm) read and write. The base
// ContainerManager is untyped (`[key: string]: any`), so this interface is what gives the
// helpers real types at their `host` parameter — keep it in sync with the fields/methods the
// helpers touch. Leaf module: imports nothing (so every helper can import the type cycle-free).

export interface ButtonRect {
  right: number;
  bottom: number;
  // left/top are present on a real rect but the geometry only consumes right/bottom.
  [key: string]: number;
}

export interface ContainerHost {
  // Elements (container/overlay/button are resolved by the base ContainerManager).
  container: HTMLElement;
  overlay: HTMLElement | null;
  button: HTMLElement;

  // Lifecycle / animation state.
  isOpen: boolean;
  isAnimating: boolean;
  animationType: string;
  animationTimeout: ReturnType<typeof setTimeout> | null;
  transitionEndHandler: ((ev?: Event) => void) | null;
  originalButtonRect: ButtonRect | null;
  originalContent: string | null;
  recentExternalLinkClick: boolean;
  resizeHandler: (() => void) | null;
  createBookHandler: ((ev?: Event) => void) | null;
  importBookHandler: ((ev?: Event) => void) | null;

  // Delegated class methods the helpers call back into (late-bound to avoid import cycles).
  openContainer(mode?: string): void;
  closeContainer(): void;
  showImportForm(): void;
  setupButtonListeners(): void;
  restoreOriginalContent(): void;
  setupResizeListener(): void;
  cleanupResizeListener(): void;
  setResponsiveFormSize(): void;
}

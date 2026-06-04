"""Zero-import leaf — the EpubTransform base class ONLY.

Lives apart from epub_normalizer.py on purpose: the live backend runs epub_normalizer.py as
`__main__` (the shim delegates via runpy), so if the phase modules imported the base back from
epub_normalizer they would re-import it as a SECOND module and deadlock (circular import). A
leaf that imports nothing from the package can never cycle. Both the orchestrator and every
phase module (structuralNormalisation / headingMatching / footnoteMatching / bibliographyDetection)
import EpubTransform from here."""
from abc import ABC, abstractmethod


class EpubTransform(ABC):
    """
    Base class for all EPUB transforms.

    Each transform is self-contained and should:
    1. Detect if its specific pattern/problem exists
    2. Transform the HTML to fix it

    Transforms should be idempotent - running twice should be safe.
    """

    name = "BaseTransform"  # Override in subclass
    description = "Base transform class"  # Override in subclass

    @abstractmethod
    def detect(self, soup) -> bool:
        """
        Check if this transform should run on this EPUB.

        Args:
            soup: BeautifulSoup object of combined EPUB HTML

        Returns:
            True if transform should run, False otherwise
        """
        pass

    @abstractmethod
    def transform(self, soup, log) -> dict:
        """
        Apply the transform to the HTML.

        Args:
            soup: BeautifulSoup object (modified in place)
            log: Function to call for logging (log(message))

        Returns:
            Dict with any extracted data (e.g., footnotes found)
        """
        pass

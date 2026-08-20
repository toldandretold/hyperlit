# Note Beta

The second note of the e2e import-batch fixture vault. It references the SAME shared figure as note-alpha, but via a wikilink embed with an alias:

![[shared-figure.png|Shared figure, embedded from beta]]

The shared image must end up in BOTH books — the vault splitter copies an image into every bundle whose markdown references it.

It also links to [[Note Alpha]] as a plain note wikilink, which is out of scope for conversion and should render as text.

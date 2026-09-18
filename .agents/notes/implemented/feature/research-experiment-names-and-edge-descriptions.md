# Experiment names and expandable arrow descriptions

Research graph cards display the localized experiment label plus the authored Run purpose instead of a UUID fragment. The fixed-width canvas uses a bounded name preview; the record panel shows the full name and status, hides the Run path, and keeps raw technical records collapsed. Stored identifiers and research provenance remain unchanged.

Arrow labels remain short to preserve routing. The Native Viewer adds optional owner-supplied artifact.edgeIds and onEdgeSelect. Only allowlisted SVG edge-label groups become keyboard-accessible buttons; iframe source/nonce checks and the edge allowlist guard callbacks. Researcher renders the full snapshot edge label with the shared safe Markdown primitive in a closable, scrollable modal. A snapshot change invalidates its selection. Node relations provide another entry to the same description.

No causal relationship is inferred: only explicit verified based_on_runs entries link experiments to later revisions. Absence of a link means no verified basis is recorded, not that the experiment necessarily had no real-world influence.

Coverage includes localized names, ID-free card labels, bounded long names, unchanged provenance, full Markdown rendering for both evidence and revision links, unsafe HTML/URL rejection, unknown/blank edge rejection, dialog close and snapshot replacement. Native owns bridge and browser gesture regressions. Live GUI verification and activation limitations are recorded separately under .artifacts/research-view/.

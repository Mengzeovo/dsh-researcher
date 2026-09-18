# Six-column wrapped research graph

The research view keeps all same-plan revisions in one graph, but wraps its plan/Run pairs after six visual columns. This supersedes the single-wide-row presentation in `continuous-research-view.md`, not its removal of revision pagination. Each row contains three versions and reads left to right; v4 and v7 start subsequent rows.

Logical columns remain compact ordinals in the read-only graph projection. The workflow mapper owns the visual mapping: physical column is logical column modulo six, and the Native lane is the integer quotient. Plan and Run IDs, details, membership, evidence and lineage edges, Run paging, and resource budgets remain unchanged. Existing empty/single-row presentation is preserved. Projection format 3 invalidates prior layout snapshots.

The Native engine’s general wider-column capability is not rolled back: six columns here is the requested research-view arrangement, not a global renderer rejection limit. Native lanes keep all rows inside one Viewer. No new page controls or selection state are introduced.

Regression coverage includes four/seven revisions, plan/Run pairing, cross-row relationships and the real Session plan 2 with v1–v3 on the first row and v4 on the second. Rendering and building do not hot-reload the current Host; online GUI acceptance remains separate.

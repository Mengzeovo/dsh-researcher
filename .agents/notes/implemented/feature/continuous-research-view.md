# Continuous same-plan research graph

## Decision

Researcher no longer pages plan revisions. Every verified revision of the selected plan is projected into one continuous Native pan/zoom graph, with compact plan/Run column pairs in revision order. Missing history remains diagnostic and cannot create lineage. This supersedes the revision-pagination choice in the earlier Native research-view note; authority records are not rewritten.

`versionsPerPage` is removed from strict Host configuration. Current selection/response types have no revision-page fields. Legacy request `versionPage` is validated and discarded; retained client selections normalize to plan ID plus Run pages. Snapshot identity uses projection format 2 and excludes obsolete page selection.

Per-revision Run paging (default/max four rows), scan/input/snapshot/detail/render budgets, scoped caches, integrity checks, cancellation, and read-only lifecycle remain in force. Oversized full-plan graphs fail explicitly rather than silently hiding revisions.

## Verification and dependency

Projection, wire, client, service, and configuration regressions cover four-revision continuity, sparse history, preserved evidence and lineage, Run-page navigation/eviction, removed config, and obsolete selection normalization. Focused Native tests pass for 4/7 revisions with four Runs each (20/35 nodes, 8/14 columns) and four discussion-only revisions through column 6, in both locales.

The earlier Native workflow schema rejected column 6 with `schema/maximum` (maximum 5); the required Native workflow v2 update supports dynamic geometry through column 127 while retaining v1 compatibility and independent resource admission. Researcher never works around incompatible renderers by wrapping or truncating columns. The linked Native integration retains default limits of 64 nodes, 128 edges, 512 KiB input, 8 MiB output, and a 15-second render timeout.

Building artifacts does not deploy to the running GUI. No GUI restart or deployment is performed by this task. Process/render resource limits still bound practical graph size; removing pagination does not promise unlimited browser or renderer capacity.

See `docs/research-view.md` for migration and presentation details.

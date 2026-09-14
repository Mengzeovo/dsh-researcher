# Native-rendered research view

## Decision

Researcher projects verified plan and Run records into a read-only graph. Native Archify owns the workflow renderer and shared browser Viewer; DSH owns generic conversation-view eligibility. The optional composition is disabled by default and does not embed another engine in researcher.

Each real plan directory forms one partition. Revisions and exactly associated Runs form nodes. Only explicit, digest-pinned experiment evidence creates Run-to-revision edges; chronology and Session history cannot manufacture provenance. Legacy authority documents remain unchanged.

The view uses disposable cold Session observations and the researcher writer mutex. Target-scoped page caches revalidate binding and file bytes before disclosure and after asynchronous rendering. The existing Typert stream mechanism carries coalesced invalidation hints, avoiding a feature-specific extension to DSH’s fixed forwarded-event list.

The Host owns activation settings. Browser Loader entries do not receive Host configuration, so the client obtains only enabled and presetIds through researcher.getViewConfig before installing the optional view. Forwarding arbitrary Host configuration risks exposing private settings; independent browser defaults cannot represent the operator’s opt-in. Default Loader startup without client configuration is a required regression case.

## Consequences

Native plugin availability is an explicit composition prerequisite only when the view is enabled. UI selection, pagination, and camera remain client-owned; authoritative records and renderer artifacts have separate identities. One visible partition renders at a time. Larger histories use navigation rather than duplicate nodes.

Inline semantic styles and plain-text details fit this plugin’s current client build. Current local development links require packaging work before portable publication. Building or testing the plugin does not deploy it to an existing GUI.

## Evidence

Owner-local tests exercise record integrity, exact evidence, pagination, byte budgets, cancellation, cache authorization, and browser controller races. The built ProfileLoader fixture persists real Session JSONL, disposes the writer, then cold-reads and renders under read-only policy without Agent startup or changed file bytes. Native tests cover actual rendering and Chromium Viewer behavior. See [research view documentation](../../../../docs/research-view.md) for configuration and limits.

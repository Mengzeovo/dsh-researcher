# Research view

The optional **视图 / View** conversation tab uses Native Archify for rendering and embedding. Researcher owns research records, graph selection, pagination, and node details; DSH owns generic conversation-view eligibility and layout. Researcher registers the `page` layout: a full-width page without the chat composer or transcript width handles, while retaining Session navigation. The page is read-only. Choosing a target explicitly runs the context-only research-load command: it loads background, disarms automatic continuation, and gives one briefing before waiting. Continuous work requires a separate explicit research-start request.

## Enable and configure

Add the Native Archify plugin to the same Host/client composition, then set this configuration on the researcher entry:

~~~yaml
config:
  view:
    enabled: true
    presetIds: [research]
~~~

The default is disabled, preserving headless and picker-only installations. The DSH client must expose uiConversation.viewVisibility.register and uiConversation.viewLayouts.register; updating only researcher is insufficient when the running DSH client predates this API. Build the affected DSH client/Web artifacts and both plugins before a maintenance reload. The Host needs researcher, sessionQuery, and archify; the client waits for the standard Session/slot/conversation/theme/locale services and archifyViewer. Native plugin 0.1.0-dev.2 exposes the required renderWorkflow and registerViewer methods. This development checkout links current DSH 0.1.5-rc.1 workspaces and uses React 18.3.1 to match their UI baseline; machine-local links are not a portable publication setup.

The browser Loader starts plugins by name without forwarding Host configuration. Each researcher client activation calls the always-available Root `researcher.getViewConfig` method before mounting the optional view. This read-only projection returns only `enabled` and `presetIds`; it does not expose Host budgets, credentials, or other configuration, and requires no Session or Agent. The Host is the only enablement authority. Refresh or remount the client after changing the Host configuration. A failed handshake fails startup and releases acquired registrations rather than enabling the view or silently substituting client defaults.

| view field | Default | Meaning |
|---|---:|---|
| versionsPerPage | 3 | Revision columns; allowed 1–3 |
| runsPerVersionPage | 4 | Run rows per revision; allowed 1–4 |
| maxRecords | 6000 | Examined records and directory entries |
| maxDataBytes | 33554432 | Combined UTF-8 input budget |
| maxSnapshotBytes | 1048576 | Complete snapshot JSON budget |
| maxDetailBytes | 524288 | Complete detail JSON budget |
| maxRenderBytes | 8388608 | Complete rendered artifact JSON budget |
| cacheEntries | 8 | Maximum cached page entries |

Pagination limits graph output, not target scanning. Page, detail, and render requests inspect target history; a smaller page does not avoid scan budgets. Aggregate budget exhaustion or failure of shared goal/state/authority directories can reject the whole view, while individual plan and Run diagnostics can preserve other verified records.

Native rendering has separate process, byte, concurrency, and timeout configuration. Busy rendering fails rather than creating an unbounded retry queue. Building bundles does not activate Host services or replace bytes already cached by a running GUI; enable and reload through the installation's normal maintenance procedure. No automatic restart or replacement server is provided.

## Graph meaning

Only actual canonical plan directories form partitions, including damaged directories with diagnostics. Every registered, verified revision is a plan node. Every admitted Run is an experiment node attached to its exact plan reference and digest. Missing references cannot invent directories. Sessions and separate result nodes are not part of the graph; Run details carry results, metrics, parameters, and source JSON.

Only explicit, hash-verified based_on_runs entries produce experiment-to-revision edges. Their reasons remain author text in either UI language. A revision declaring no experiment evidence is a discussion- or research-driven succession: it draws one direct revises-plan edge from the previous committed revision, labeled with its authored change notes. The two edge semantics never coexist on the same transition, and a missing predecessor record cannot invent lineage. Historical records are never rewritten to fill missing provenance. Invalid ledgers, missing files, unregistered revisions, and mismatched references remain diagnostics without hiding healthy partitions. Unsealed, completed, failed, and pending-state publication are distinct; an active target does not prove a running process.

One active partition owns one Viewer. The default page contains at most three revisions and twelve Runs. Run order is createdAt followed by Run ID; paging and camera belong to the client entry store. New records do not select the newest page or node. Off-page evidence and lineage links carry a destination selection instead of duplicate or placeholder graph nodes.

## Read APIs and lifecycle

The optional researchView Remote namespace exposes getView, getViewNode, renderView, and watchView. Strict browser-safe JSON validation covers requests and typed display fields. Raw Run detail is an opaque JSON object for text inspection, not a second browser-side authority parser.

Reads use a disposable Session observation, its header workspace, and the binding projection's wire value. They do not create an Agent, publish a live Session, resume a Goal, or mutate research records. Dataset reads share the writer's target mutex. Snapshot identity includes observed file bytes and normalized page selection, not only state revision.

Cache authorization binds canonical workspace and research ID with a process-local opaque token. Different Sessions bound to that same target may share pages; other targets, workspaces, and unbound Sessions cannot redeem them. Detail and render reads recheck binding and file identity, including after asynchronous native rendering. Artifact revisions additionally bind the spec digest, engine fingerprint, theme, and locale. Cancel, eviction, invalidation, and service disposal end native work.

watchView is a cancellable Typert stream, not an addition to DSH's fixed forwarded-event allowlist. It opens with an invalidation hint, then coalesces matching committed-operation hints. Clients reread authority; hints are not research history and may repeat. Only an active page whose read confirms a bound target subscribes, including targets with no plan nodes. An unbound response cancels any previous stream and clears its disconnect warning. Selecting a target rereads the binding before subscribing; a different target token replaces the old subscription. The initial Host hint closes the read/subscribe race. Leaving or disposal aborts the stream, reconnection replaces it, and a genuine failure or unexpected stream end remains visible until explicit refresh rather than an automatic retry loop. An unbound page does not monitor other Sessions for target binding changes; refresh or reenter the page to observe those changes. External file edits are detected on subsequent reads or manual refresh; there is no filesystem watcher.

## Presentation and verification

The Native plugin owns the sandboxed iframe, nonce validation, camera protocol, and standalone SVG download. Researcher imports its types and services, never its React components or engine source. The interface uses localized semantic tokens and inline styles because this plugin has no CSS-module pipeline. Narrow displays scroll the three columns horizontally; document and Run details render as text, not Markdown HTML.

Owner-local tests cover authority integrity, paging, explicit evidence, byte budgets, cancellation, scoped caches, and client races. Real Native tests render the projected fifteen-node graph in both supported languages. A real browser-style Cordis Loader regression starts the client with `create({name})` and verifies Host-controlled visibility, disabled picker-only behavior, startup failure cleanup, and cancellation. Built-plane ProfileLoader tests exercise the Root configuration endpoint with the view both enabled and disabled and require current DSH and Native artifacts and the researcher build; unit or jsdom tests alone are not an online GUI acceptance check.

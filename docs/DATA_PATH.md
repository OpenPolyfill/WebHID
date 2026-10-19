# Data Path Analysis

This document describes the current production topology and its application-level boundary accounting. It does not publish latency estimates. Measured benchmark datasets, including their hardware and harness caveats, are in [BENCHMARK.md](BENCHMARK.md).

Production paths are NM, worker WS, and worker WT. `wt-inpage` remains implemented only for benchmark and test runs and is described in the benchmark-only section below.

A key invariant is that every browser document always has its own direct page bridge and exact `webhid-control` Port. Same-origin top-broker fanout is an optional upgrade for the NM **data plane** only; it does not replace that direct control bridge.

## Execution contexts

| Symbol | Context | Role |
| --- | --- | --- |
| P | Page MAIN world | WebHID polyfill and page-facing MessagePorts |
| B | Direct isolated bridge for the document | Always-present exact control bridge, worker setup, local NM fallback, consent and scope control |
| T | Top-frame isolated bridge acting as optional NM broker | Owns same-origin fanout contexts, shared NM runtime data Ports, and per-child attachments when the upgrade succeeds |
| W | Per-device data worker | Production WS or WT transport and direct page data port |
| G | Extension background | Exact endpoint authority, runtime-Port dispatch, Native Messaging connection and Port-first NM input routing |
| D | `webhid-daemon` | Sessions, physical Entries, HID reader, I/O worker, WS/WT server |
| F | `webhid-native-messaging` forwarder | Stdio to daemon socket/pipe relay, only in forwarder deployment |

## Persistent connections and deployment profiles

### Browser connections

| Surface | Lifetime | Used for |
| --- | --- | --- |
| Page control MessagePort, P<->B | Page/document bridge lifetime | Ordinary page API control traffic; always direct for that document |
| `webhid-control` runtime Port, B<->G | Exact browser endpoint lifetime | Serialized normal bridge control, authenticated endpoint metadata, fanout offer setup, and exact-frame cleanup |
| Page data MessagePort, P<->B or P<->W | Device/client plane lifetime | Local NM report traffic or direct WS/WT worker traffic |
| `webhid-data:<deviceId>` runtime Port, B<->G | Local direct NM device lifetime | Direct/unbrokered NM report and feature traffic |
| Private broker MessagePort, B<->T | Optional paired same-origin document lifetime | Broker pairing plus `nmAttach`/`nmDetach`/teardown only; not steady-state report traffic |
| Attachment data MessagePort, P<->T | Optional brokered NM client/device lifetime | Brokered child's steady-state NM report requests, acknowledgements and input reports |
| Shared `webhid-data:<deviceId>` runtime Port, T<->G | Top-owned NM device lifetime | Top NM users plus all broker-attached same-origin children for that device |
| Native Messaging Port, G<->host | Background connection lifetime | Daemon-backed control and NM report traffic |
| WS or WT, W<->D | Worker/device transport lifetime | Production worker data plane |

Background registers runtime Ports from `runtime.onConnect` with `registerContentPort`. Normal bridge control traffic is not a series of `runtime.sendMessage` calls. `browser.runtime.connectNative()` creates the persistent Native Messaging Port; later messages reuse it instead of spawning another host process.

### Native Messaging deployment profiles

| Profile | Browser to daemon path | Extra forwarder socket/pipe hop? |
| --- | --- | ---: |
| Daemon as Native Messaging host | `G -> Native Messaging stdio -> D` | No |
| Persistent daemon plus forwarder | `G -> Native Messaging stdio -> F -> Unix socket or Windows named pipe -> D` | Yes |

The tables below show both profiles where the extra forwarder hop changes accounting. Do not read `F` as part of daemon-as-host mode.

## Direct bridge baseline and optional broker upgrade

Every frame starts on the direct path:

```text
P <-> B <-> webhid-control <-> G
```

For an eligible same-origin non-top frame, `B` may additionally offer an NM broker upgrade only after its exact direct `webhid-control` endpoint exists. The child bridge generates a per-document stack OTP and sends `fanoutChildOffer` through that exact control Port. Background validates the live child and top endpoints and their same origin, generates fresh `authOtp` and `ackOtp`, then sends separate pairing offers to child and top. Background keeps no fanout context.

Top `T` creates a private broker MessageChannel. The candidate crosses top MAIN to child MAIN through a one-shot stack-gated `navigator.hid` setter handoff; the child accepts only the exact generated `webhidBroker_<token>` caller frame for its stack OTP. Child and top isolated bridges then mutually authenticate with `fanoutAuthA(authOtp)` and `fanoutAuthB(ackOtp)`. Offers time out and are invalidated on stale document lifetimes.

Pairing does **not** replace `B`, the child's `navigator.hid`, or the child's `webhid-control` Port. It merely makes `T` available as an NM data-plane owner. If pairing is not ready when an NM plane opens, the child can use its ordinary local `webhid-data:<deviceId>` Port.

When a paired child attaches an NM plane, `B` creates an attachment MessageChannel, sends one endpoint to `T` with `nmAttach`, and transfers the other endpoint to `P`. Steady-state report traffic then bypasses child `B`:

```text
P <-> attachment MessagePort <-> T <-> shared webhid-data:<deviceId> <-> G
```

Once a particular plane has been broker-attached, broker or attachment loss makes that plane unavailable rather than silently manufacturing a new child-local data Port.

## Production path inventory

| Path | Operation | Current route |
| --- | --- | --- |
| A | Browser-local control | `P <-> B <-> webhid-control runtime Port <-> G` for `getPolicy`, paired-device state, page-action state and picker bookkeeping; some settings resolve in `B` or an extension page |
| B | Daemon-backed control | `P -> B -> webhid-control -> G -> Native Messaging -> D`, or `-> F -> D`, for `enumeratePaired`, `open`, `close`, `handshake`, and `setDataPlane`; the direct child control route remains unchanged even when its NM data plane is brokered |
| C | WS output or feature | `P <-> W <-> WS <-> D <-> persistent IoCommand worker <-> HID` |
| D | WT output or feature | `P <-> W <-> WT <-> D <-> persistent IoCommand worker <-> HID` |
| E | Direct NM output or feature | `P -> B -> local webhid-data:<deviceId> -> G -> Native Messaging -> D -> persistent IoCommand worker -> HID`, with `F -> D` added in forwarder mode |
| F | WS input | `HID -> reader -> event-broadcast queue -> D/batching -> WS -> W -> transferred page MessagePort -> P` |
| G | WT input | `HID -> reader -> event-broadcast queue -> D/batching -> WT -> W -> transferred page MessagePort -> P` |
| H | Direct NM input, Port-first | `HID -> reader -> nm_hot sink queue -> Native Messaging -> G -> local webhid-data:<deviceId> -> B -> page data MessagePort -> P` |
| I | NM input, exact-owner fallback | Same as H until `G`; only when no matching data runtime Port exists, `G -> exact session-owner webhid-control Port -> B -> page event/data dispatch` |
| J | First open | Daemon-backed direct control -> `OpenReservation` -> physical HID open -> publish Entry -> register Session -> release reader-start gate -> optional data-plane setup |
| K | Additional open | Daemon-backed direct control -> register another Session on an existing Entry -> optional data-plane setup |
| L | Close | Daemon-backed direct control -> revoke one Session's authority; physical Entry teardown only after the final Session or a force-close/failure condition |
| M | Same-origin broker pairing/attach | Optional setup only: exact child `webhid-control` offer -> background-authenticated OTP offers -> stack-gated candidate handoff -> isolated mutual auth -> `nmAttach` attachment transfer |
| N | Brokered-child NM output or feature | `P -> attachment -> T -> shared webhid-data:<deviceId> -> G -> Native Messaging -> D -> persistent IoCommand worker -> HID` |
| O | Brokered-child NM input | `HID -> reader -> nm_hot sink queue -> Native Messaging -> G -> shared webhid-data:<deviceId> -> T -> attachment -> P` |

`sendReport`, `sendFeatureReport`, and `receiveFeatureReport` use E for direct NM and N for a broker-attached child. Control operations stay on B in both cases.

## Direct worker paths

### Output and feature requests

For WS and WT, page and worker communicate over the transferred per-device data MessagePort. The bridge transfers the worker control port during setup but does not relay normal report traffic afterward.

```text
P data MessagePort -> W -> WS or WT -> D -> IoCommand queue -> persistent HID handle
D -> WS or WT -> W -> P data MessagePort
```

The worker owns request ids and transport acknowledgement handling. It builds the binary transport frame, and the daemon queues an authority-validated `IoCommand`. The I/O worker serializes output, feature write, and feature read against the persistent HID handle, then returns completion through a oneshot reply to the daemon task.

### Input reports

The daemon batches WS and WT input independently of the page MessagePort. The worker parses each received transport frame and transfers report buffers directly to the page. The normal direct route is:

```text
HID -> reader -> event-broadcast queue -> WS or WT -> worker -> transferred MessagePort -> page
```

Bridge involvement is limited to setup, spawn/despawn, data-plane change, transport failure, and NM fallback. There is no worker-to-bridge-to-page relay fallback.

## Native Messaging paths

### Direct NM output and feature requests

Without the optional broker upgrade, the page transfers its report payload to its own direct bridge through its data MessagePort. The bridge assigns a runtime-Port request id and posts through a local persistent `webhid-data:<deviceId>` Port. Background packs output and feature-write requests as base64 TLV data on the persistent Native Messaging connection. `receiveFeatureReport` is a JSON action on that same connection.

On the daemon, the active client and device must have a valid `nm_hot` binding. Its `IoCommand` captures the binding validity and current Entry `io_epoch`; the persistent I/O worker checks both before the HID operation. The acknowledgement returns on the same Native Messaging connection, then the same per-device runtime Port, then the page data MessagePort.

### Brokered same-origin child NM

For a paired child, the direct bridge still owns control and Session authority but the NM data plane can be attached to top `T`. Child `B` creates the attachment once; after it transfers the page endpoint, steady-state report requests go directly between child `P` and top `T`. Top translates those attachment requests onto its shared `webhid-data:<deviceId>` runtime Port. Acknowledgements return through the same shared Port and attachment.

Top fans input reports received on that shared runtime Port to all matching attachment data Ports. The private broker Port itself carries lifecycle/setup (`nmAttach`, `nmDetach`, broker teardown), not per-report traffic.

### Input reports and fallback

The input reader calls `route_nm_input` before considering the generic broadcast channel. It creates a packed NM input message for each valid, active client-bound `nm_hot` sink. The client writer sends it through the already-connected Native Messaging stream.

Background decodes the packed message and tries the matching `webhid-data:<deviceId>` runtime Port first. If at least one such Port exists, that route is authoritative and there is no second input delivery. A top-owned shared Port therefore receives one report and fans it locally to its own page plus broker attachments.

Only when **no matching data runtime Port exists** does background fall back to the exact `webhid-control` Ports that own live Sessions for that device. This fallback is endpoint-scoped; NM input reports do not use `tabs.sendMessage` as a tab-wide fallback.

The generic broadcast event path still supports non-NM sessions and lifecycle/device events. It is not the primary NM input-report path.

## Logical Sessions and physical Entries

A Session is a unit of ownership and transport authority. An Entry is the shared physical device lifetime.

### First open

1. The daemon creates an `OpenReservation` while serializing lifecycle changes.
2. It opens the physical HID device.
3. It creates the Entry's reader-start gate, reader, persistent I/O queue and worker, epoch, and report-blocking state.
4. It publishes the Entry.
5. It registers the first logical Session and refreshes its NM hot binding if NM is active.
6. It releases the reader-start gate only after publication.

### Additional open

A later or concurrent open registers another logical Session against the already-published Entry. It shares the physical HID handle, reader, and I/O worker. It does not inherently reopen hidapi or start another reader or worker.

### Close, frame replacement, and failure

Closing one Session removes its `ws_auth_hash` mapping, revokes its transport capability, signals cancellation, and refreshes NM authority for the relevant client. The Entry remains live while another active Session references the device. The last close, reader error, or force-close removes the Entry, advances `io_epoch`, wakes the reader-start gate, stops the I/O worker, and joins the physical lifetime.

Browser ownership is exact-document scoped. Each direct bridge owns a real `webhid-control` runtime endpoint registered from browser-provided tab/frame/document/origin metadata. Control-Port disconnect or replacement retires that endpoint and purges the frame generation's Sessions; a top-document replacement also invalidates stale pending work before it can publish ownership. Tab removal remains a broader cleanup path. Optional fanout contexts are top-bridge-local and do not replace this direct endpoint lifetime.

## Authority relevant to the data path

| Mechanism | Role |
| --- | --- |
| Exact direct `webhid-control` endpoint | Browser-authenticated document owner for page control and Session lifetime |
| `persistentOrigin` | Storage/settings/grant partition. Normal origins use themselves; safely derivable opaque documents use `opaque|<top-origin>|<source-origin>`; missing authority fails closed |
| Fanout stack OTP | One-shot MAIN-world gate tying top-to-child broker candidate transfer to the intended child document |
| `authOtp` / `ackOtp` | Fresh isolated-world mutual authentication for the optional private broker Port |
| `ws_auth_hashes` | Maps `ws_auth_hash -> session_token`, not the reverse |
| `TransportGrant` and `TransportCapability` | Bind WS or WT transport work to one Session generation and support immediate revocation |
| Session cancellation | Stops work derived from a closed or revoked logical Session |
| `nm_hot` | Client and device binding for NM input sink and persistent I/O authority |
| `io_epoch` | Invalidates queued commands from a physical Entry being torn down or replaced |
| `OpenReservation` and lifecycle serialization | Serialize first-open, concurrent-open, close, and force-close transitions |
| Reader-start gate | Prevents the reader from observing an unpublished or invalidated Entry |

## Copy and hop accounting

Counts below are application-level handoffs at the canonical component boundaries shown in the routes. Each directional crossing of a named MessagePort, runtime Port, Native Messaging surface, WS/WT transport, explicit queue, or HID boundary counts once. The reader-to-event-broadcast queue, reader-to-`nm_hot` sink queue, and daemon-task-to-persistent-I/O-worker queue are included. The I/O oneshot completion is counted in the reverse direction. Internal transport-task queues, browser-internal scheduling, TLS, TCP, UDP, kernel, and allocator copies are excluded. These are handoff counts, not copy counts or latency measurements.

Broker pairing and `nmAttach` are one-time setup/lifecycle operations and are intentionally excluded from steady-state per-report accounting.

| Path | Handoffs, daemon-as-host | Handoffs, forwarder | Known application payload transformations |
| --- | ---: | ---: | --- |
| Browser-local control request and response | 4 | 4 | Page control MessagePort and runtime-Port messages; policy/storage/picker state resolution |
| Daemon-backed control request and response | 6 | 8 | Page control MessagePort, runtime-Port messages and Native Messaging JSON framing; control payloads are not hot-path report data |
| WS or WT output plus acknowledgement | 8 | 8 | Page payload transfer to worker; worker frame creation; daemon payload extraction; HID write-buffer construction; transport framing; oneshot completion reply |
| Direct NM output/feature plus acknowledgement | 10 | 12 | Page-to-direct-bridge transfer; runtime-Port structured clone; packed TLV/base64 encode/decode; daemon payload extraction; HID write-buffer construction; JSON/native-message framing; oneshot completion reply |
| Brokered-child NM output/feature plus acknowledgement | 10 | 12 | Page-to-top attachment transfer replaces page-to-child-bridge transfer; the remaining runtime/NM/daemon path is identical to direct NM |
| WS input | 4 | 4 | Reader event-broadcast queue and daemon batch framing; worker parse and report-buffer creation; worker-to-page buffer transfer |
| WT input | 4 | 4 | Reader event-broadcast queue and daemon batch framing; worker parse and report-buffer creation; worker-to-page buffer transfer |
| Direct NM input, data-Port first | 5 | 6 | Packed input construction and base64 encode/decode; reader-to-`nm_hot` queue; background report allocation; runtime-Port structured clone |
| Brokered-child NM input | 5 | 6 | Shared runtime-Port delivery followed by top-to-child attachment transfer; same boundary count as direct NM input |
| NM input, exact-owner control fallback | 5 | 6 | Used only without a matching data runtime Port; the G->B crossing is the exact owner `webhid-control` Port rather than a data Port |

The steady-state derivations are:

- Browser-local control has four: `P->B`, `B->G`, `G->B`, and `B->P`.
- Daemon-backed control has six direct: `P->B`, `B->G`, `G->D`, `D->G`, `G->B`, and `B->P`. Forwarder mode adds one D<->F crossing in each direction, producing eight.
- Direct WS/WT output has eight: `P->W`, `W->D`, `D->I/O worker`, `I/O worker->HID`, `HID->I/O worker`, `I/O worker->D`, `D->W`, and `W->P`.
- Direct NM output has ten: `P->B`, `B->G`, `G->D`, `D->I/O worker`, `I/O worker->HID`, `HID->I/O worker`, `I/O worker->D`, `D->G`, `G->B`, and `B->P`. Forwarder mode adds one D<->F crossing in each direction, producing twelve.
- Brokered-child NM output also has ten: `P->T` over the attachment, then the same `T->G->D->I/O->HID` round trip and return. The optional child broker setup happened earlier and is not a per-report hop.
- WS/WT input has four: `HID->reader`, `reader->event-broadcast queue`, `D->W` through the transport boundary, and `W->P`.
- Direct NM input has five: `HID->reader`, `reader->nm_hot sink queue`, `D->G`, `G->B` through the matching data Port, and `B->P`. Forwarder mode replaces `D->G` with `D->F->G`, adding one.
- Brokered-child NM input substitutes `G->T` shared-data-Port plus `T->P` attachment for the direct `G->B` plus `B->P`, so its steady-state count remains five direct or six with a forwarder.
- Exact-owner fallback also remains five/six; only the browser delivery surface changes from the data runtime Port to the owning control Port.

## Benchmark-only WT in-page variant

The benchmark harness can write `dataPlane: 'wt'` and `useWorker: false`. In that variant the MAIN-world page receives the derived transport authentication value needed to establish WT, not the daemon Session bearer token. It is retained as a benchmark/control configuration to measure the cost of moving transport handling and parsing back onto the page main thread. It is intentionally hidden from normal settings because it is not the preferred production architecture and performs worse under page CPU and render load. It is excluded from the production path inventory and accounting above.

`BENCHMARK.md` retains the `wt-inpage` datasets because they describe code that the benchmark exercises. Those results must be interpreted as benchmark-only, not as production-mode guidance.

## Current implementation references

- `addon/js/content/isolated/bridge.js`: exact direct bridge, optional same-origin broker pairing/attachments, `webhid-control`, `webhid-data:<deviceId>`, worker setup and NM fallback.
- `addon/js/content/main/index.js`: page WebHID surface, direct bootstrap port capture, stack-OTP-gated broker candidate handoff, worker/page data Ports.
- `addon/js/background/messages.js` and `content-ports.js`: exact runtime endpoint registration, authority, fanout OTP offers and Port dispatch.
- `addon/js/background/nm.js`: persistent Native Messaging connection and Port-first NM input delivery with exact-session-owner control-Port fallback.
- `addon/js/utils/settings.js`: `persistentOrigin` derivation and opaque persistence partitioning.
- `crates/webhid-daemon/src/device_mgr.rs`: Sessions, Entries, reservations, `nm_hot`, authority, reader, and persistent I/O worker.
- `crates/webhid-daemon/src/client.rs`: persistent NM client writer and report dispatch.
- `crates/webhid-daemon/src/batching.rs`, `websocket.rs`, and `webtransport.rs`: transport framing and batched delivery.
- `tests/regression/input-report-fanout.spec.ts` and `tests/regression/nm-runtime-port.spec.ts`: same-origin report delivery, child lifecycle, and session endpoint cleanup.

# Development Guide

## Prerequisites

### Runtime

| Dependency   | Package (Arch)             | Why                     |
| ------------ | -------------------------- | ----------------------- |
| `libudev.so` | `systemd`                  | Daemon hot-plug (Linux) |
| `hidapi`     | built from source by cargo | HID device access       |

### Build

| Dependency        | Package (Arch)     | Why                                             |
| ----------------- | ------------------ | ----------------------------------------------- |
| Rust ≥ 1.85       | `rustup` or `rust` | edition 2024                                    |
| `libudev` headers | `systemd`          | `udev` crate links at build time                |
| `pkg-config`      | `pkgconf`          | hidapi build                                    |
| `zip`             | `zip`              | Building addon XPI                              |
| Node.js ≥ 20      | `nodejs`           | Running Playwright tests, linter, and formatter |

```sh
sudo pacman -S rust systemd pkgconf zip nodejs
```

## Dev Container

The repository includes a lightweight Debian `node:22-bookworm-slim` devcontainer, which works with Zed's Dev Container support. Open the repository in Zed and choose the devcontainer environment. Creation runs `npm ci --ignore-scripts`; it does not run a build or test suite.

The configuration keeps the shell as the non-root `node` user and uses the container runtime's `keep-id` user namespace mapping so mounted files remain writable with rootless Podman, as used by the Zed setup. Use the equivalent host-UID mapping when using another runtime.

The image includes Rust stable with `rustfmt` and `clippy`, Node/npm, the native Linux build dependencies, and Firefox installed through the repository's Playwright dependency. These workflows are supported inside the container:

```sh
npm run build:rs:debug
npm run build:addon
npm run test:rs
npm run lint
npm run lint:js
npm run lint:rs
npm run test:browser:src
```

The existing `.cargo/config.toml` rustc wrapper remains active. Check Linux E2E device access from inside the container with:

```sh
.devcontainer/check-uhid.sh
```

Linux E2E additionally requires the host kernel's `/dev/uhid`, permission to open it, and access to the `hidraw` nodes created by `webhid-mock`. The image does not load kernel modules, pass devices by default, or request `--privileged`. If the check reports `UHID unavailable` or `UHID present but not writable`, normal development and browser tests remain usable.

The standard devcontainer intentionally does not advertise E2E support. Docker and Podman device flags can expose `/dev/uhid`, but they do not mount the dynamically created `/dev/hidraw*` nodes into the container. A device-cgroup rule alone is not sufficient, and a broad `/dev` bind mount or `--privileged` would unnecessarily weaken isolation. Do not add either to the normal Zed configuration.

For the supported Linux E2E path, run the suite on the host after applying the existing rule and joining the `webhid` group:

```sh
sudo make install-e2e-udev-rule
newgrp webhid
npm run test:conformance
npm run test:regression
npm run test:regression:forwarder
```

If a separate container runtime integration can explicitly pass each newly created VID `0x16C0` `hidraw` node, it must also preserve the `webhid` group permissions and the host-assigned device major/minor values. Do not guess those values. This is intentionally outside the default devcontainer because dynamic device passthrough is runtime-specific.

## Building

```sh
# Debug
cargo build --manifest-path crates/Cargo.toml

# Release
make build                # or: make build CARGO_ARGS=--frozen

# Addon XPI (zips addon/, default MV3; use MV=2 for MV2)
npm run build:addon          # or: MV=2 npm run build:addon
```

`npm run build:addon` runs `scripts/build-addon.mjs`, which validates the manifest, copies it into `dist/addon/`, minifies each JS/CSS/HTML file per-file (terser, no bundling: files keep their own identity), and zips the XPI.

Binaries: `crates/target/{debug,release}/webhid-daemon`, `webhid-native-messaging`, and `webhid-mock` (Linux + macOS, test helper).

## Running for development

Two terminals:

### Terminal 1: daemon

```sh
# Option A: root (simplest)
sudo RUST_LOG=debug crates/target/debug/webhid-daemon

# Option B: udev rule (recommended)
sudo make install-udev-rule
RUST_LOG=debug crates/target/debug/webhid-daemon
```

Override socket path: `WEBHID_SOCKET=/tmp/webhid-dev.sock RUST_LOG=debug crates/target/debug/webhid-daemon`

### Terminal 2: browser

1. Load addon via `about:debugging → Load Temporary Add-on → addon/manifest.json`
2. Per-user NM manifest (if not installed system-wide):

```sh
mkdir -p ~/.mozilla/native-messaging-hosts
cat > ~/.mozilla/native-messaging-hosts/webhid.forwarder_nm_host.json << EOF
{
  "name": "webhid.forwarder_nm_host",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

For daemon-as-NM-host mode, point `path` to the daemon binary directly:

```sh
cat > ~/.mozilla/native-messaging-hosts/webhid.daemon_nm_host.json << EOF
{
  "name": "webhid.daemon_nm_host",
  "description": "WebHID daemon as native-messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-daemon",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

Restart browser after writing these files. Paths must be absolute.

### Environment variables

| Variable                    | Default                                                                                                                                                                                        | Description                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBHID_SOCKET`             | `@webhid` (Linux root, abstract) / `$XDG_RUNTIME_DIR/webhid/webhid.sock` or `/run/user/<uid>/webhid/webhid.sock` (Linux user) / `$HOME/Library/Application Support/webhid/webhid.sock` (macOS) | Unix socket path used by the persistent-daemon forwarder profile; not used by daemon-as-NM-host.                                                                                                      |
| `WEBHID_PIPE`               | `\\.\pipe\webhid` (Windows)                                                                                                                                                                    | Named pipe path used by the persistent-daemon forwarder profile.                                                                                                                                      |
| `WEBHID_WS_PORT`            | `0` (OS-assigned random)                                                                                                                                                                       | WebSocket server port, forced to 0 in Native Messaging host mode.                                                                                                                                     |
| `WEBHID_WS_BATCH_MS`        | `0`                                                                                                                                                                                            | Input report flush policy. `0` = rate-gated (immediate flush for a single report, 25µs coalescing for sparse bursts, 8ms coalescing once ~12+ reports land in a 4ms window). `1`+ = fixed N ms timer. |
| `WEBHID_WS_HIGH_RATE_MS`    | `8`                                                                                                                                                                                            | Coalesce window (ms) used when the high-rate threshold is met.                                                                                                                                        |
| `WEBHID_WS_RATE_WINDOW_MS`  | `4`                                                                                                                                                                                            | Window (ms) over which the flushed-report count is measured.                                                                                                                                          |
| `WEBHID_WS_HIGH_RATE_COUNT` | `12`                                                                                                                                                                                           | Flushed reports within the rate window that trigger the high-rate coalesce window.                                                                                                                    |
| `RUST_LOG`                  | `info`                                                                                                                                                                                         | Log level.                                                                                                                                                                                            |

Note: the user systemd unit (`manifests/webhid-daemon.user.service`) hardcodes `WEBHID_WS_PORT=31337` for backwards compatibility. The system unit and daemon default use port 0 (random, OS-assigned).

### Addon settings

| Setting                            | Values                            | Default                                          | Description                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlane`                        | `ws` / `wt` / `nm`                | `wt` when available, otherwise `ws`              | Report data plane. WT uses worker WebTransport when the handshake offers it; selected WT uses worker WS when no WT endpoint is offered; worker setup or transport failure can move the device to NM. Daemon-backed control still uses Native Messaging, while browser-local control does not.            |
| `workerSpawnMode`                  | `shadow` / `blob`                 | `shadow` (MV3) / `blob` (MV2)                    | How the data worker is spawned in page context. Shadow uses `new Worker(location.href)` with webRequest interception. Blob uses the extension worker bundle and CSP path. CSP preflight can select NM for shadow; a failed blob spawn also falls back to NM. Hidden unless a worker will actually spawn. |
| `daemonAsNmHost`                   | bool                              | `false` (`true` on macOS and Windows when unset) | Use daemon-as-NM-host, rather than the persistent-daemon forwarder profile.                                                                                                                                                                                                                              |
| `hidePageAction`                   | bool                              | `false`                                          | Keep the Firefox page-action icon hidden even after a page uses WebHID; the browser action still opens the device view.                                                                                                                                                                                  |
| `logLevel`                         | 0 to 3                            | `1`                                              | 0=error, 1=warn, 2=info, 3=debug.                                                                                                                                                                                                                                                                        |
| `devicePickerMode`                 | `modal` / `pageAction` / `window` | `modal`                                          | Device picker UI mode.                                                                                                                                                                                                                                                                                   |
| `workerPolyfillEnabled`            | bool                              | `false`                                          | Inject the WebHID polyfill into page-created Web Workers.                                                                                                                                                                                                                                                |
| `allowActivationlessRequestDevice` | bool                              | `false`                                          | Skip the user-activation check in `requestDevice()` for sites that request devices after asynchronous work. This is a spec deviation; explicit chooser selection and Permissions Policy still apply.                                                                                                     |

`daemonAsNmHost` and `hidePageAction` are global-only. Every other user-facing setting can be overridden per persistent site scope via the popup. `useWorker` is an internal benchmark setting, not a user-facing settings option. Settings use per-key format in `browser.storage.local`: global keys are `settings :: <name>`, site overrides are `settings :: <persistentOrigin> :: <name>`. Normal documents use their origin as `persistentOrigin`; safely derivable opaque documents use `opaque|<top-origin>|<source-origin>`. Device info, persistence-scope allowlists, and grant groups are stored in IndexedDB (`webhid-store`).

The bridge uses a `SettingsStore` Proxy-based observer. `storage.onChanged` extracts `changes[k].newValue` and calls `settings.set(patch)`. The store handles diffing internally and fires listeners only when a value actually changes.

## Testing

`npm test` runs WebHID conformance checks. WebIDL, Permissions Policy, activation, and Dedicated Worker coverage lives in `tests/conformance/browser/`. The mock-device scenarios in `tests/conformance/e2e/` cover permission grants, descriptor exposure, device lifecycle, events, input/output report I/O, and errors for unsupported feature-report IDs.

```sh
npm ci
npx playwright install firefox
npm test
# Browser checks against the source or built addon:
npm run test:browser:src
npm run test:browser
```

The standard Playwright configuration is `tests/playwright.config.ts`. E2E runs use daemon-as-Native-Messaging-host mode and one worker because tests share virtual HID devices. They require the debug binaries (`cargo build --manifest-path crates/Cargo.toml`) and Linux `/dev/uhid` access. The existing Linux setup below installs `manifests/72-webhid-e2e.rules`.

On Linux, install the UHID rule and grant the test user access once:

```sh
sudo groupadd --system webhid 2>/dev/null || true
sudo usermod -aG webhid "$USER"
sudo install -Dm644 manifests/72-webhid-e2e.rules /etc/udev/rules.d/72-webhid-e2e.rules
sudo modprobe uhid
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Log out and back in, or run `newgrp webhid`, before starting E2E tests. macOS uses `IOHIDUserDevice` and needs no setup. The browser-only harness disables Firefox's `network.lna.enabled` preference, so it does not test the local-network-access permission prompt.

Focused regressions live in `tests/regression/` and protect cross-context permission isolation, hostile page intrinsics, session lifetime, input-report fan-out, and transport revocation. Chooser and consent behavior is covered by conformance.

```sh
npm run test:regression
# The forwarder profile runs only NM runtime-port and session-revocation scenarios.
npm run test:regression:forwarder
# Conformance E2E and daemon-host regressions without browser-only specs:
npm run test:e2e
```

The forwarder project deliberately runs only `nm-runtime-port.spec.ts` and `transport-revoke.spec.ts`. The complete E2E suite is not repeated for a second daemon deployment profile. Playwright retries are disabled so a failing first run remains visible.

JavaScript unit tests and Rust protocol, descriptor, device identity, and security invariants are separate commands:

```sh
npm run test:unit
npm run test:rs
```

Benchmarks use `tests/playwright.benchmark.config.ts` and run independently from conformance and regressions:

```sh
npm run test:benchmark
npm run test:benchmark:loss
```

## Repository layout

```
FF-WebHID/
├── addon/                   Firefox extension (MV2 + MV3)
│   ├── manifest.json        Active MV3 manifest; `manifest.v2.json` is the MV2 variant
│   ├── js/
│   │   ├── background/      Startup, message handlers, persistent NM, storage, state, CSP, and webRequest code
│   │   ├── content/main/    MAIN-world WebHID polyfill, including page-created worker context
│   │   ├── content/isolated/ Bridge, picker, and production data worker
│   │   ├── internal/pages/  Picker, popup, settings, and devices extension pages
│   │   └── utils/           Shared settings, transport, wire-format, resource, and UI helpers
│   ├── css/                 Shared and theme CSS
│   ├── icons/               Extension icons
│   └── res/                 Device-type resources
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared protocol/types, device identity, packed formats, and collection TLV serialization
│   ├── webhid-daemon/      HID daemon, WS/WT servers, batching, hot-plug, blocklist, and persistent device I/O
│   ├── webhid-native-messaging/ Thin NM stdio-to-platform-IPC forwarder
│   └── webhid-mock/         Virtual HID device mocker for E2E tests
│
├── manifests/               Native Messaging manifests, service units, and udev rules
├── packaging/               Platform packaging
├── tests/                   Playwright browser, E2E, benchmark, fixture, and helper code
├── scripts/                 Build and descriptor-generation scripts
└── docs/                    Architecture, specification, data path, development, installation, and benchmark docs
```

The tree above is intentionally a map of responsibilities, not an exhaustive file listing. The test helper and fixture directories contain the current browser and daemon harness details.

## Packaging (Arch Linux)

```sh
# Daemon + NM host + systemd service
cd packaging/linux/archlinux/webhid && makepkg -si

# Browser extension (system-wide XPI, downloads from AMO)
cd packaging/linux/archlinux/webhid-addon && makepkg -si
```

## Versioning

Versioning uses [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) (configured in `.versionrc.json`). Current version: 3.2.0.

```sh
npm run release
npm run release:minor
npm run release:patch
```

Bumps the release-owned version surfaces declared in `.versionrc.json`: `.version.json`, `package.json`, Firefox `addon/manifest.json` and `addon/manifest.v2.json`, the three release `Cargo.toml` files plus `crates/Cargo.lock`, Homebrew/Nix metadata, and the Void/Alpine/Arch addon packaging files. The Chromium manifest is a test-bed manifest and is not part of the release bump set.

## Cross-platform

CI builds on Linux, Windows, and macOS. Platform-specific code is gated with `#[cfg]`:

| Platform | Persistent-daemon IPC                                 | Hot-plug                   | hidapi feature        | Daemon-as-NM-host                      |
| -------- | ----------------------------------------------------- | -------------------------- | --------------------- | -------------------------------------- |
| Linux    | Unix socket, including abstract `@webhid` for root    | udev monitor               | `linux-static-hidraw` | Yes, with user HID permissions         |
| macOS    | Unix socket under the user's Application Support path | IOHIDManager callbacks     | `macos-shared-device` | Yes, with Input Monitoring as required |
| Windows  | Named pipe (`\\.\pipe\webhid`)                        | RegisterDeviceNotification | `windows-native`      | Yes                                    |

Daemon-as-NM-host works on all listed platforms. Firefox supplies the manifest path and addon ID as two positional arguments; Chromium supplies one extension-origin argument. The addon selects the host name from `daemonAsNmHost`. On macOS and Windows, that setting defaults to `true` when no value is stored.

The NM forwarder uses vectored I/O (`write_vectored`) on all platforms (no `splice()`).

## Makefile

Most build/package/bump workflows live in `package.json` (they were pure npm/node wrappers). The Makefile keeps the install/uninstall targets that need root or system integration:

| Target                                                   | Effect                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `make build`                                             | Release build of daemon + NM host                                        |
| `make install-system`                                    | System-wide install: binaries + NM manifest + systemd unit, `/usr/local` |
| `make install-user`                                      | User-local install into `~/.local` (no root)                             |
| `make install-udev-rule`                                 | Install `72-webhid.rules` (uaccess + FIDO exclusions)                    |
| `make install-e2e-udev-rule`                             | Install the test-device udev rule and add `$SUDO_USER` to the `webhid` group |
| `make install-webhid-group`                              | Create the `webhid` group and add `$SUDO_USER`                           |
| `make install-daemon-nm-host-system` / `-user`           | Install daemon binary + `webhid.daemon_nm_host` manifest                 |
| `make uninstall` / `uninstall-system` / `uninstall-user` | Remove the above                                                         |
| `make test` / `make clean` / `make help`                 | Misc                                                                     |

Overridable variables: `PREFIX`, `USER_PREFIX`, `CARGO_ARGS`, `WEBHID_GROUP`, `SYSTEM_NM_DIR`, `SYSTEMD_DIR`, `UDEV_DIR`, `USER_NM_DIR`, `USER_SYSTEMD_DIR`.

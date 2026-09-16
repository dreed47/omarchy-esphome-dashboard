# Changelog

## [0.4.7] - 2026-09-16

### Security

Seventh round of marketplace review. 0.4.6 closed the descriptor-identity
gap on config file I/O and made the keyring authoritative for the HA
config, but the CI workflow itself was still a supply-chain gap: both
`actions/checkout@v4` and `actions/setup-node@v4` are mutable tags, so a
future workflow run could execute code different from what was reviewed.

- Pinned both actions in `.github/workflows/test.yml` to their exact
  commit SHA (`actions/checkout@08eba0b`, `actions/setup-node@49933ea`),
  keeping the version as a trailing comment for readability.

## [0.4.6] - 2026-09-11

### Security

Sixth round of marketplace review. 0.4.5 hardened `ha.json` (which holds
`baseUrl`) with ancestor-directory verification, `O_NOFOLLOW`, atomic
write, and fsync - but that's still check-then-use: the verification
step and the actual open/rename/unlink each re-resolve the path by name,
leaving a directory-swap race between them. Two fixes that close this
rather than narrow it further:

- **The Home Assistant config is now single-sourced in the OS keyring.**
  `baseUrl` and `verifyTls` moved into the same Secret Service item as
  the token (one JSON blob instead of just the bare token), so the
  keyring - not a file - is authoritative for the whole config. There's
  nothing left in this plugin's own config directory for a directory
  swap to redirect on the read path. `ha.json` still exists, but only as
  a best-effort, non-authoritative local cache; its failure no longer
  blocks a save or a read.
- **File operations are now pinned to a directory file descriptor
  instead of a re-resolved pathname.** Linux resolves
  `/proc/self/fd/<fd>/<name>` relative to the *already-open* directory
  behind `<fd>`, not by walking the pathname from `/` again - that gives
  `openat()`/`renameat()`-relative-to-a-descriptor semantics from plain
  Node `fs`, with no native addon or helper process. `readHaConfig`'s
  one-time migration read (the last place a file's `baseUrl` is still
  trusted, for pre-0.4.6 installs) and the local cache's write/delete
  paths all go through a single pinned directory fd now, collapsing what
  used to be several independent pathname re-resolutions (lstat, mkdir,
  open, rename) into one directory-level open plus fd-relative
  operations.

Verified live against two real attack simulations: a config-directory
symlink swap during a save/read no longer leaks anything into the
attacker's directory (the keyring write still succeeds since it doesn't
depend on the file at all, and the cache-file write is cleanly refused);
a legacy pre-keyring file with an attacker-controlled `baseUrl`+token,
reached through a swapped directory, is refused outright rather than
migrated into the keyring. Also re-ran the real shell restart / device
discovery / HA connection check from prior rounds against the new code
paths - all still work.

## [0.4.5] - 2026-09-11

### Security

Fifth round of marketplace review. The token itself moved to the keyring
in 0.4.4, but the reviewer correctly pointed out that `ha.json` (holding
`baseUrl`) is still integrity-sensitive: it controls WHERE that keyring
token gets sent, so a directory-symlink swap could redirect it to an
attacker-controlled endpoint even though the token's own storage is now
solid. Four fixes:

- `ha.json` is back to the hardened read/write path from 0.4.2/0.4.3
  (ancestor-directory verification, `O_NOFOLLOW`, atomic write, fsync) -
  not because its contents are secret, but because its integrity
  determines where a secret goes. (The one difference from before: the
  read-side permission check now only requires no group/other *write*
  access, not unreadability - this file has nothing to keep confidential,
  and requiring 0600-class permissions rejected a file written by a
  slightly older build with default 0644 permissions for no real reason.)
- Migration from the pre-keyring format no longer falls back to trusting
  the legacy plaintext token forever if moving it into the keyring fails
  partway - it fails closed (reports "not configured") instead of keeping
  the original exposure alive indefinitely.
- **TLS certificate verification is on by default.** Previously it
  defaulted off (many local HA instances have a self-signed or expired
  cert) - sending a bearer token over an unverified TLS connection is
  interceptable by anyone who can get in the middle of it. `--insecure`
  is now only accepted for a loopback base URL (`127.0.0.1`/`::1`/
  `localhost`); `ha-token` refuses to save it for anything else. The
  settings form defaults new setups to verification on and shows an
  explicit warning when it's off.
- The CLI now kills any child process it's still waiting on (`avahi-browse`)
  on its own `SIGTERM`/`SIGINT`, so Service.qml's 20-second stuck-poll
  cancellation (which can only signal this process directly, not a whole
  process group) can't orphan one. `status --json` output is also capped
  at 8MB before printing, on top of the existing 32MB cap on the raw HA
  response, since Quickshell's own stdout collector buffers whatever this
  process emits in full.

Verified live: re-ran the same symlink attack simulations from 0.4.3
against the reinstated `ha.json` hardening (both refused, same as
before); confirmed `--insecure` against a non-loopback URL is rejected
with a clear error; confirmed a real `avahi-browse` child gets killed
when the CLI is sent SIGTERM mid-discovery, leaving no orphan; confirmed
normal `status`/`ha-status`/save/forget all still work and a live shell
restart still finds all 10 devices and stays connected to Home Assistant.

## [0.4.4] - 2026-09-11

### Security / Changed

- **The Home Assistant access token is no longer stored in a file at all.**
  After three rounds of marketplace security review on hardening a
  from-scratch credential file (`ha.json`), the reviewer's own suggested
  alternative was adopted instead: the token now lives in the freedesktop
  Secret Service (`gnome-keyring` — a hard dependency of the `omarchy`
  package itself, so this is guaranteed present, not optional), stored and
  retrieved via `secret-tool` (a trusted absolute path,
  `/usr/bin/secret-tool`) with the token passed over stdin/stdout, never
  argv. `ha.json` now holds only the non-secret base URL and TLS setting.
  This removes the whole class of directory-symlink/TOCTOU concern a
  from-scratch file store raises, rather than continuing to narrow it.
- Existing installs migrate silently and automatically on first read: a
  legacy `ha.json` with the token still in it is moved into the keyring
  and the file is rewritten without it — no need to re-enter your token
  after updating.
- `ha-forget` and the popup's **Forget** button now also clear the
  keyring entry.

## [0.4.3] - 2026-09-11

### Security

Third round of marketplace review on the Home Assistant token file
(`ha.json`): the 0.4.2 fix protected the file itself against a symlink at
its own final path component, but a pathname-based `mkdirSync`/
`chmodSync`/`openSync`/`renameSync` still resolves each *ancestor*
directory (`~/.config`, `~/.config/omarchy`, `.../esphome-dashboard`)
through the normal symlink-following path lookup.

- Before creating or using the token file's directory, every already-
  existing ancestor from `$HOME` down is now checked with `lstatSync`:
  refuses to proceed if any of them is a symlink or not owned by this
  user, re-checked again immediately before the temp file is opened.
  Node's core `fs` has no `openat`/`renameat`-relative-to-a-directory-
  descriptor API — the one thing that closes this fully — so this narrows
  the window rather than eliminating it; doing so requires an attacker
  who can already write into one of these directories as this same user,
  which is already code-execution parity with this process.
- Reading the token file now also refuses it if it's hardlinked from
  anywhere else (`nlink !== 1`) or has any group/other permission bits
  set, on top of the existing regular-file/owner/size checks.
- Writing now `fsync`s the temp file's data before closing it, and
  `fsync`s the containing directory after the rename, so the atomic
  replace is durable rather than just atomic.

Verified against two real attack simulations, not just unit tests: (1) a
symlink planted at `ha.json` itself is refused on read and its directory
entry is atomically replaced (never followed) on write, leaving the
symlink's target file completely untouched; (2) the `esphome-dashboard`
directory itself replaced with a symlink to another directory is refused
outright before anything is written, leaving that directory empty.

## [0.4.2] - 2026-09-11

### Security

Second round of marketplace security review, addressed proactively rather
than one comment at a time:

- `avahi-browse` (mDNS discovery) now also spawns via a trusted absolute
  path (`/usr/bin/avahi-browse`) instead of ambient `PATH` resolution —
  same class of issue as 0.4.1's `node`/`omarchy-notification-send` fix,
  found by auditing every remaining process spawn in the codebase rather
  than waiting for it to be flagged individually.
- Home Assistant HTTP responses are now capped at 32MB and the connection
  aborted if exceeded, so a misbehaving or compromised HA endpoint can't
  grow this process's memory without limit by streaming an unbounded
  response.
- The Home Assistant token file (`ha.json`) is now read and written
  through symlink-safe, owner-checked, size-bounded file descriptors
  (`O_NOFOLLOW`, regular-file + owner + size checks on read) and written
  atomically (temp file in the same directory, `O_EXCL` + mode 600 from
  creation, then renamed into place) instead of a plain
  `readFileSync`/`writeFileSync`. Its directory is now also created and
  kept at mode 700. This closes a local symlink-planting attack against
  the file holding the bearer token, and makes a corrupted/oversized file
  at that path fail closed (treated as "not configured") instead of being
  trusted.
- Every dynamic `Text` element (device names, platform/board info, alert
  text, HA-sourced button labels) now sets `textFormat: Text.PlainText`
  explicitly, matching Omarchy's own first-party convention. Without it,
  Qt Quick's default `Text.AutoText` auto-detects and renders limited
  HTML-like markup, so a crafted device or entity friendly-name (from
  mDNS or a Home Assistant entity) could otherwise trigger unintended
  rich-text rendering or a resource load.

## [0.4.1] - 2026-09-11

### Security

- All process spawns now use trusted absolute paths (`/usr/bin/node`,
  `/usr/bin/omarchy-notification-send`) instead of resolving them by name
  through the shell's inherited `PATH`. Flagged in marketplace review:
  since the Home Assistant token is sent to `node` over stdin and button
  presses can trigger physical actions (a garage door's toggle), anything
  earlier on that `PATH` able to intercept `node` could have captured the
  token or spoofed a device action. Both binaries are fixed, package-owned
  locations (`nodejs`, `omarchy`) — if either isn't actually there, the
  spawn just fails, which this plugin already treats as "CLI missing" /
  a no-op notification, not a crash.

## [0.4.0] - 2026-09-11

### Added

- **Generic Home Assistant button actions** — any `button.*` entity HA has
  for a device (restart, sync, query status, a ratgdo's toggle door, a tag
  reader's write/clean/cancel-tag actions, ...) now shows up as a row of
  buttons on that device's card, calling the same `button.press` service
  HA's own UI uses. Labels are cleaned up from HA's often-redundant
  friendly names down to just the action ("Restart", "Toggle door").
  Buttons that move something physical or mutate data (toggle door,
  write/clean/cancel tag) require a confirm click first; routine ones
  (restart, sync, query) are single-click. New CLI: `press-button`.

### Fixed

- Settings form's Save button never enabled when only the base URL changed
  and the token field was left blank — blank now correctly means "keep the
  saved token", at every layer (UI, service, CLI), matching what the hint
  text already promised.
- Settings form's Save button could get stuck on "Saving…" forever: the
  CLI's stdin reader kept the Node process alive even after finishing, so
  the QML side never saw it exit. The CLI now exits explicitly once its
  work is done.

## [0.3.0] - 2026-09-11

### Added

- **Settings page in the popup** — a gear icon opens a form to enter or
  change the Home Assistant base URL, access token, and TLS verification,
  and a **Forget** button to disconnect. No terminal required for Phase 2
  setup anymore (the CLI flow from 0.2.0 still works too). The token field
  is masked, never re-displayed, and travels to the CLI over the process's
  stdin rather than argv - the same mechanism Omarchy's own Wi-Fi panel
  uses for an 802.1X password.

### Changed

- **Icon**: replaced the generic FA4 wifi glyph with ESPHome's own mark,
  drawn as an inline SVG (just the circuit-squiggle linework, no background)
  so it tints via the bar's own colors like every other icon instead of
  carrying a fixed brand color or background block.

## [0.2.0] - 2026-09-11

Phase 2: optional Home Assistant integration for firmware updates.

### Added

- Connect a Home Assistant long-lived access token
  (`esphome-dashboard ha-token`, token on stdin, saved mode 600 in its own
  file) to see and install pending OTA firmware updates per device, read
  from HA's own `update.*` entities — the same data its own UI shows.
- Popup: an **Update available: vX → vY** badge per device with an
  **Install…** button (two-click confirm — installing reboots the device)
  that calls HA's `update.install` service, the same action HA's own
  "Install" button performs. Nothing talks to the ESPHome Dashboard
  directly.
- New `firmware` notification class (on by default): one notification per
  device per new version, not re-sent once seen.
- New CLI: `ha-token`, `ha-forget`, `ha-status`, `update-install`.

### Notes

- Entirely optional and additive — with no token saved, everything behaves
  exactly as in 0.1.0. A failed or unreachable HA call just means no
  firmware data that poll; it never breaks device discovery or health.
- TLS verification is off by default for the HA connection (many local HA
  instances run a self-signed or otherwise-mismatched certificate); pass
  `--verify-tls` to require a valid one.

## [0.1.0] - 2026-09-11

First release. Phase 1: mDNS discovery + health, no configuration.

### Added

- **Bar pill** showing `online/total` ESPHome devices. Accent when a
  reachable device has no API encryption; urgent when a device is confirmed
  offline.
- **Popup** listing every device — platform/board, firmware version, live
  online/offline dot, latency, and an unencrypted-API flag.
- **Headless service** polling the fleet and notifying on confirmed offline,
  recovery, and first-sighting of a new device. A device only counts as
  offline after missing `confirmMisses` (default 2) consecutive polls, so a
  battery/deep-sleep node napping between readings doesn't trigger a false
  alarm.
- **`esphome-dashboard` CLI** — `status`, `devices`, `ping`. Discovery via
  `avahi-browse _esphomelib._tcp` (the mDNS service every ESPHome device
  advertises for Home Assistant's native API); health via a raw TCP connect
  to each device's API port.

### Notes

- No configuration or credentials required — this is pure mDNS + TCP.
- Live-tested against a real 10-device fleet; found and now flags 3 devices
  with no API encryption set.

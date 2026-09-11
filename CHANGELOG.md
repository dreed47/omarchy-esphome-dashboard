# Changelog

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

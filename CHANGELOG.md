# Changelog

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

# Changelog

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
- Deeper Home Assistant integration (OTA update-available badges, remote
  compile/flash) is possible as a later, opt-in phase using a Home
  Assistant long-lived access token, but is **not** in this release.

// Pure half of the ESPHome dashboard: parses `avahi-browse -rtp _esphomelib._tcp`
// (the mDNS service every ESPHome device advertises for Home Assistant's
// native API) into device records, and classifies fleet health once the
// impure side (lib/io.mjs) has TCP-probed each one. No child processes, no
// filesystem, no clock beyond what is passed in — all unit-testable.

// ---- `avahi-browse -rtp _esphomelib._tcp` --------------------------
//
//   =;wlp2s0;IPv4;stairlights;_esphomelib._tcp;local;stairlights.local;192.168.86.191;6053;"api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256" "network=wifi" "board=lolin_s2_mini" "platform=ESP32" "mac=84fce6c66bc0" "config_hash=01f4733f" "version=2026.8.2" "friendly_name=StairLights"
//
// Devices built from an ESPHome "project" (ratgdo, the Voice PE) additionally
// carry `package_import_url`, `project_name`, `project_version`. Plain
// user configs do not - those fields are optional.

function parseTxt(txtField) {
    const out = {}
    const re = /"([^=]+)=([^"]*)"/g
    let m
    while ((m = re.exec(txtField))) out[m[1]] = m[2]
    return out
}

export function parseEsphomeDevices(avahiOut) {
    const byName = new Map()
    for (const line of String(avahiOut || "").split("\n")) {
        if (!line.startsWith("=")) continue
        const f = line.split(";")
        if (f.length < 10) continue
        const name = f[3]
        const host = f[6]
        const address = f[7]
        const port = parseInt(f[8], 10) || 6053
        const txt = parseTxt(f.slice(9).join(";"))

        const rec = {
            name,
            friendlyName: txt.friendly_name || name,
            host,
            address,
            port,
            mac: (txt.mac || "").toLowerCase(),
            platform: txt.platform || "",
            board: txt.board || "",
            network: txt.network || "",
            espVersion: txt.version || "",
            projectName: txt.project_name || "",
            projectVersion: txt.project_version || "",
            configHash: txt.config_hash || "",
            apiEncrypted: /^Noise_/.test(txt.api_encryption || ""),
        }
        // Same device can be seen on more than one local interface (wifi +
        // ethernet); keep the first sighting, they describe the same node.
        if (!byName.has(name)) byName.set(name, rec)
    }
    return [...byName.values()].sort((a, b) => a.friendlyName.localeCompare(b.friendlyName))
}

// ---- health classification -----------------------------------------

// Merge discovery records with a { address: {online, latencyMs} } probe map.
export function mergeHealth(devices, healthByAddress) {
    return devices.map((d) => {
        const h = (healthByAddress && healthByAddress[d.address]) || { online: false, latencyMs: -1 }
        return { ...d, online: !!h.online, latencyMs: h.latencyMs }
    })
}

const SECURITY_WARN = "API not encrypted (no Noise psk set)"

export function deviceAlerts(device) {
    const a = []
    if (!device.online) a.push({ code: "offline", text: "offline", severity: "error" })
    if (device.online && !device.apiEncrypted) a.push({ code: "no-encryption", text: SECURITY_WARN, severity: "warn" })
    return a
}

export function worstSeverity(devices) {
    let sev = "ok"
    for (const d of devices || []) {
        if (!d.online) return "error"
        if (!d.apiEncrypted) sev = "warn"
    }
    return sev
}

export function summaryLine(devices) {
    const list = devices || []
    if (!list.length) return "No ESPHome devices found"
    const offline = list.filter((d) => !d.online).length
    const base = list.length + (list.length === 1 ? " device" : " devices")
    if (offline === 0) return base + " · all online"
    return base + " · " + offline + (offline === 1 ? " offline" : " offline")
}

export function shortMac(mac) {
    const m = String(mac || "").replace(/[^0-9a-f]/gi, "")
    return m.length >= 4 ? m.slice(-4).toUpperCase() : ""
}

export function platformGlyph(platform) {
    // FA microchip for anything recognised, question mark otherwise.
    return /esp/i.test(String(platform || "")) ? "" : ""
}

// ---- debounced offline confirmation ---------------------------------
//
// Battery/deep-sleep ESPHome nodes (a tag reader that wakes only to read a
// tag, say) miss a TCP health check routinely without being "down" - a
// single miss is not a fault. `missCounts` (persisted across polls by the
// caller) counts consecutive misses per device name; a device only counts
// toward severity/notifications once it has missed `threshold` polls in a
// row. The live `online` flag on each device is untouched - the popup can
// still show the instant truth, just without treating one blip as an alarm.

export function stepMissCounts(devices, prevMissCounts) {
    const next = {}
    for (const d of devices || []) {
        const prev = (prevMissCounts && prevMissCounts[d.name]) || 0
        next[d.name] = d.online ? 0 : prev + 1
    }
    return next
}

export function isConfirmedOffline(name, missCounts, threshold) {
    return ((missCounts && missCounts[name]) || 0) >= threshold
}

export function worstSeverityConfirmed(devices, missCounts, threshold) {
    let sev = "ok"
    for (const d of devices || []) {
        if (!d.online && isConfirmedOffline(d.name, missCounts, threshold)) return "error"
        if (d.online && !d.apiEncrypted) sev = "warn"
    }
    return sev
}

export function summaryLineConfirmed(devices, missCounts, threshold) {
    const list = devices || []
    if (!list.length) return "No ESPHome devices found"
    const offline = list.filter((d) => !d.online && isConfirmedOffline(d.name, missCounts, threshold)).length
    const base = list.length + (list.length === 1 ? " device" : " devices")
    if (offline === 0) return base + " · all online"
    return base + " · " + offline + (offline === 1 ? " offline" : " offline")
}

// ---- diff successive polls -> notifications -------------------------
//
// `prevOnline` is a { name: bool } map of what was known last poll (from
// PersistentProperties). Returns which devices flipped which way, plus any
// name seen for the first time ever (`isNew`, decided by the caller from its
// own "ever seen" set, not tracked here).
export function diffOnline(devices, prevOnline) {
    const prev = prevOnline || {}
    const wentOffline = []
    const cameOnline = []
    for (const d of devices || []) {
        const was = prev[d.name]
        if (was === true && d.online === false) wentOffline.push(d)
        if (was === false && d.online === true) cameOnline.push(d)
    }
    return { wentOffline, cameOnline }
}

export function onlineMap(devices) {
    const m = {}
    for (const d of devices || []) m[d.name] = d.online
    return m
}

// ---- CLI arg parsing ------------------------------------------------

export const COMMANDS = ["status", "devices", "ping", "ha-token", "ha-forget", "ha-status", "update-install"]

const VALUE_FLAGS = new Set(["--host", "--port", "--timeout", "--base-url", "--entity"])
const BOOL_FLAGS = new Set(["--json", "--verify-tls"])

export function parseArgs(argv) {
    const out = { cmd: "", positionals: [], json: false }
    const rest = argv.slice()
    out.cmd = rest.shift() || ""
    if (out.cmd === "-h" || out.cmd === "--help") { out.help = true; out.cmd = "" }
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (a === "-h" || a === "--help") out.help = true
        else if (BOOL_FLAGS.has(a)) out[a.slice(2)] = true
        else if (VALUE_FLAGS.has(a)) out[a.slice(2)] = rest[++i]
        else if (a.startsWith("--")) throw new Error("unknown option: " + a)
        else out.positionals.push(a)
    }
    return out
}

export const HELP = `esphome-dashboard - fleet status for your ESPHome devices

usage:
  esphome-dashboard status  [--json]              overview the bar/popup render from
  esphome-dashboard devices [--json]              mDNS discovery only, no health probe
  esphome-dashboard ping    --host IP [--port 6053] [--timeout ms] [--json]

  esphome-dashboard ha-token --base-url URL [--verify-tls]
                                              read a token on stdin, verify it, save it
  esphome-dashboard ha-forget                 delete the saved Home Assistant token
  esphome-dashboard ha-status [--json]        raw update.* entities from Home Assistant
  esphome-dashboard update-install --entity update.xxx [--json]
                                              ask Home Assistant to install that update

Discovery is mDNS (_esphomelib._tcp, the service every ESPHome device
advertises for Home Assistant's native API) - no configuration, no
credentials. "status" also TCP-connects to each device's API port to tell
real reachability from a stale mDNS cache entry.

Home Assistant integration is optional (Phase 2): once a token is saved,
"status" also reports OTA update availability per device by reading HA's
own update.* entities - the same information HA's UI shows.
`


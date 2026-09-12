// Pure half of the optional Home Assistant integration (Phase 2): reads
// HA's `update.*` entities (the platform HA uses for any device with
// available-firmware info, ESPHome included) and correlates them with the
// devices mDNS already found, so a card can show "v2026.6.0 -> v2026.9.0"
// without needing the ESPHome Dashboard itself to be reachable.
//
// No network here - lib/io.mjs does the HTTP; this only shapes JSON that is
// already in hand.

import { URL } from "node:url"

// HA's `GET /api/states` returns one object per entity:
//   { entity_id, state, attributes: {...}, last_changed, last_updated }
// For `update.*` entities the attributes of interest are:
//   installed_version, latest_version, title, release_url, release_summary,
//   in_progress, friendly_name. state is "on" (update available), "off", or
//   "unavailable"/"unknown".
export function parseUpdateEntities(states) {
    const out = []
    for (const s of states || []) {
        if (!s || typeof s.entity_id !== "string" || !s.entity_id.startsWith("update.")) continue
        const a = s.attributes || {}
        out.push({
            entityId: s.entity_id,
            friendlyName: String(a.friendly_name || s.entity_id),
            available: s.state === "on",
            unavailable: s.state === "unavailable" || s.state === "unknown",
            installedVersion: a.installed_version != null ? String(a.installed_version) : "",
            latestVersion: a.latest_version != null ? String(a.latest_version) : "",
            title: String(a.title || ""),
            releaseUrl: String(a.release_url || ""),
            releaseSummary: String(a.release_summary || ""),
            inProgress: !!a.in_progress,
        })
    }
    return out
}

function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// Correlate an entity of a given domain (e.g. "update.", "button.") to one
// of our mDNS-discovered devices. HA's entity_id is usually
// `<domain><device_slug>_<suffix>`, and its friendly_name usually starts
// with the device's own friendly name - match on whichever slug contains
// the other, trying the device's mDNS name first (stable) and its
// friendly_name second (what the user renamed it to in HA, may differ).
function matchEntityToDevice(entity, devices, domainPrefix) {
    const eSlug = slug(entity.entityId.slice(domainPrefix.length))
    const eFriendly = slug(entity.friendlyName)
    let best = null
    for (const d of devices || []) {
        const nameSlug = slug(d.name)
        const friendlySlug = slug(d.friendlyName)
        const hit =
            (nameSlug && (eSlug.includes(nameSlug) || eFriendly.includes(nameSlug))) ||
            (friendlySlug && (eSlug.includes(friendlySlug) || eFriendly.includes(friendlySlug)))
        if (hit) { best = d; break }
    }
    return best
}

export function matchDeviceForEntity(entity, devices) {
    return matchEntityToDevice(entity, devices, "update.")
}

// Attach a `firmwareUpdate` field (or null) to every device.
export function mergeFirmwareUpdates(devices, updateEntities) {
    const byDeviceName = new Map()
    for (const e of updateEntities || []) {
        const d = matchDeviceForEntity(e, devices)
        if (d && !byDeviceName.has(d.name)) byDeviceName.set(d.name, e)
    }
    return (devices || []).map((d) => {
        const e = byDeviceName.get(d.name)
        if (!e) return { ...d, firmwareUpdate: null }
        return {
            ...d,
            firmwareUpdate: {
                entityId: e.entityId,
                available: e.available,
                installedVersion: e.installedVersion,
                latestVersion: e.latestVersion,
                releaseUrl: e.releaseUrl,
                releaseSummary: e.releaseSummary,
                inProgress: e.inProgress,
            },
        }
    })
}

// HA's `button.*` entities are stateless actions (restart, sync, write a
// tag, ...). Attributes of interest: friendly_name, device_class (HA sets
// "restart" for restart buttons, otherwise usually absent/"" for
// integration-defined ones like ESPHome's).
export function parseButtonEntities(states) {
    const out = []
    for (const s of states || []) {
        if (!s || typeof s.entity_id !== "string" || !s.entity_id.startsWith("button.")) continue
        const a = s.attributes || {}
        out.push({
            entityId: s.entity_id,
            friendlyName: String(a.friendly_name || s.entity_id),
            deviceClass: String(a.device_class || ""),
        })
    }
    return out
}

// Sibling buttons on the same device usually share a leading phrase in
// their friendly_name that isn't derived from the device's mDNS name or
// its own friendly name at all - e.g. a ratgdo device named "ratgdo" over
// mDNS still gets "Garage Door Restart" / "Garage Door Sync" / ... from HA,
// "Garage Door" coming from wherever HA/the integration decided to label
// it. Comparing every sibling's friendly_name word-by-word finds that
// shared prefix regardless of where it came from. Skipped for a device
// with only one button, where "the whole name matches" is not meaningful.
function commonWordPrefix(entities) {
    if (!entities || entities.length < 2) return []
    const wordLists = entities.map((e) => String(e.friendlyName || "").split(/\s+/))
    const minLen = Math.min(...wordLists.map((w) => w.length))
    const prefix = []
    for (let i = 0; i < minLen; i++) {
        const s = slug(wordLists[0][i])
        if (s && wordLists.every((w) => slug(w[i]) === s)) prefix.push(wordLists[0][i])
        else break
    }
    return prefix
}

// A button's friendly_name is usually "<device label> <action>", sometimes
// with the device's own name repeated twice (HA auto-generated vs. the
// entity's own name both baked in, e.g.
// "Tagreader-Bedroom TagReader Bedroom Restart"). Strip every leading word
// that matches a token from the device's friendly name/mDNS name, or from
// the word-prefix shared by all of its sibling buttons, so what is left is
// just the action ("Restart", "Write Tag Random", ...).
function buttonLabel(entity, device, sharedPrefixWords) {
    const stripSet = new Set()
    for (const w of String(device.friendlyName || "").split(/\s+/)) {
        const sl = slug(w)
        if (sl) stripSet.add(sl)
    }
    for (const w of String(device.name || "").split(/[^a-zA-Z0-9]+/)) {
        const sl = slug(w)
        if (sl) stripSet.add(sl)
    }
    for (const w of sharedPrefixWords || []) {
        const sl = slug(w)
        if (sl) stripSet.add(sl)
    }
    const words = String(entity.friendlyName || "").split(/\s+/)
    let i = 0
    while (i < words.length && stripSet.has(slug(words[i]))) i++
    const label = words.slice(i).join(" ").trim()
    return label || entity.friendlyName
}

// Buttons that mutate physical state (the garage door itself) or destroy/
// overwrite data (NFC tag writes) get a confirm-before-press UI; buttons
// that just query status or trigger a routine action (restart, sync) are
// single-click. Judged from entity_id/device_class, not the display label,
// since labels get reworded but the entity_id's action suffix does not.
const RISKY_ENTITY_PATTERN = /toggle|write|clean|cancel|erase|delete|remove|reset|factory|format|safe_mode/i

export function isRiskyButton(entity) {
    return RISKY_ENTITY_PATTERN.test(entity.entityId)
}

// Attach a `buttons` array (possibly empty) to every device.
export function mergeButtons(devices, buttonEntities) {
    const byDeviceName = new Map()
    for (const e of buttonEntities || []) {
        const d = matchEntityToDevice(e, devices, "button.")
        if (!d) continue
        if (!byDeviceName.has(d.name)) byDeviceName.set(d.name, [])
        byDeviceName.get(d.name).push(e)
    }
    return (devices || []).map((d) => {
        const entities = byDeviceName.get(d.name) || []
        const sharedPrefix = commonWordPrefix(entities)
        return {
            ...d,
            buttons: entities.map((e) => ({
                entityId: e.entityId,
                label: buttonLabel(e, d, sharedPrefix),
                risky: isRiskyButton(e),
            })),
        }
    })
}

export function haConfigured(cfg) {
    return !!(cfg && cfg.baseUrl && cfg.token)
}

// Normalise a base URL: no trailing slash, defaults to https.
export function normalizeBaseUrl(url) {
    let u = String(url || "").trim()
    if (u === "") return ""
    if (!/^https?:\/\//i.test(u)) u = "https://" + u
    return u.replace(/\/+$/, "")
}

// The HA access token is sent on every request; skipping TLS certificate
// verification means anyone able to intercept the connection (a rogue AP,
// ARP/DNS spoofing, a compromised router) can read it. That's only an
// acceptable trade-off when the connection can't leave the machine at all
// - a loopback address, e.g. because HA is reached through a local
// reverse proxy or an SSH tunnel. Used to gate --insecure: verification is
// on by default and can only be turned off for a loopback base URL.
export function isLoopbackBaseUrl(baseUrl) {
    let u
    try { u = new URL(String(baseUrl || "")) } catch { return false }
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (h === "localhost" || h === "::1") return true
    return /^127(\.\d{1,3}){3}$/.test(h)   // all of 127.0.0.0/8 is loopback, not just 127.0.0.1
}

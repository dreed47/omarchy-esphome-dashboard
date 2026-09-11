// Pure half of the optional Home Assistant integration (Phase 2): reads
// HA's `update.*` entities (the platform HA uses for any device with
// available-firmware info, ESPHome included) and correlates them with the
// devices mDNS already found, so a card can show "v2026.6.0 -> v2026.9.0"
// without needing the ESPHome Dashboard itself to be reachable.
//
// No network here - lib/io.mjs does the HTTP; this only shapes JSON that is
// already in hand.

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

// Correlate an update entity to one of our mDNS-discovered devices. HA's
// entity_id is usually `update.<device_slug>_firmware` / `_update`, and its
// friendly_name usually starts with the device's own friendly name - match
// on whichever slug contains the other, trying the device's mDNS name first
// (stable) and its friendly_name second (what the user renamed it to in HA,
// may differ).
export function matchDeviceForEntity(entity, devices) {
    const eSlug = slug(entity.entityId.slice("update.".length))
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

// Impure side of the ESPHome dashboard: mDNS discovery and TCP health probes.
// Kept apart from deviceLogic.mjs so the parsing/classification there stays
// pure and unit-testable.

import { execFile, execFileSync } from "node:child_process"
import { connect } from "node:net"
import { request as httpsRequest } from "node:https"
import { URL } from "node:url"
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(
            cmd, args,
            { maxBuffer: 8 * 1024 * 1024, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", ...opts },
            (err, stdout) => resolve(err ? "" : stdout)   // best-effort: no devices, no avahi -> just empty
        )
    })
}

// Trusted absolute path (owned by the `avahi` package), not ambient-PATH
// resolution - see the nodeBin/notifyBin comment in Service.qml for why
// this matters even for a read-only poll: this is the automatic-poll
// child process, so an attacker-controlled `avahi-browse` earlier on the
// long-lived shell's inherited PATH would get run silently and repeatedly.
const AVAHI_BROWSE_BIN = "/usr/bin/avahi-browse"

// Every ESPHome device advertises this mDNS service for HA's native API.
export const avahiBrowseEsphome = () =>
    run(AVAHI_BROWSE_BIN, ["-rtp", "_esphomelib._tcp"], { timeout: 8000 })

// TCP-connect to the device's native API port. A clean connect means the
// device is up and answering right now - stronger than trusting mDNS cache,
// which can go stale for minutes after a device drops off the network.
export function tcpHealthCheck(address, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const started = Date.now()
        const sock = connect({ host: address, port, timeout: timeoutMs })
        let done = false
        const finish = (online) => {
            if (done) return
            done = true
            sock.destroy()
            resolve({ online, latencyMs: online ? Date.now() - started : -1 })
        }
        sock.on("connect", () => finish(true))
        sock.on("timeout", () => finish(false))
        sock.on("error", () => finish(false))
    })
}

// Probe every device in parallel; returns { address: {online, latencyMs} }.
export async function healthCheckAll(devices, timeoutMs) {
    const pairs = await Promise.all(
        (devices || []).map(async (d) => [d.address, await tcpHealthCheck(d.address, d.port, timeoutMs)])
    )
    return Object.fromEntries(pairs)
}

// ---- Home Assistant integration (Phase 2, opt-in) ------------------
//
// Reads OTA update-available status for ESPHome devices via HA's own
// `update.*` entities, and can trigger an install through HA's
// `update.install` service - the same thing pressing "Install" in HA's own
// UI does. Nothing talks to the ESPHome Dashboard directly.
//
// The bearer token itself is never written to our own config directory at
// all - it lives in the freedesktop Secret Service (gnome-keyring, a hard
// dependency of the `omarchy` package itself: see `pacman -Qi omarchy` and
// `pactree -r libsecret`, which shows libsecret -> gcr -> gnome-keyring ->
// omarchy - so this is guaranteed present, not an optional extra). ha.json
// holds only the non-secret baseUrl/verifyTls, which don't need any of
// this: they're not useful to an attacker and aren't worth protecting
// against a symlink-swapped directory the way a bearer credential is.
//
// This replaced an earlier from-scratch attempt at a hardened credential
// file (O_NOFOLLOW, ancestor-directory verification, atomic rename,
// fsync) after marketplace review (omacom/omarchy-plugin-marketplace#6343)
// pointed out that pure Node.js has no openat()/renameat()-relative-to-a-
// directory-descriptor API, so a from-scratch file store can narrow a
// directory-symlink race but never fully close it. Using the OS's own
// credential store sidesteps the problem instead of chasing it further.

const HA_CONFIG_DIR = join(homedir(), ".config", "omarchy", "esphome-dashboard")
const HA_CONFIG_PATH = join(HA_CONFIG_DIR, "ha.json")

export function haConfigPath() { return HA_CONFIG_PATH }

// Trusted absolute path (owned by the `libsecret` package - see above),
// not ambient-PATH resolution, same convention as every other executable
// this plugin spawns.
const SECRET_TOOL_BIN = "/usr/bin/secret-tool"
const SECRET_ATTRS = ["application", "io.github.dreed47.esphome-dashboard", "account", "ha-token"]
const SECRET_LABEL = "ESPHome Dashboard: Home Assistant token"

function secretToolStore(token) {
    execFileSync(SECRET_TOOL_BIN, ["store", "--label=" + SECRET_LABEL, ...SECRET_ATTRS], {
        input: token, timeout: 10000,
    })
}
function secretToolLookup() {
    try {
        const out = execFileSync(SECRET_TOOL_BIN, ["lookup", ...SECRET_ATTRS], { encoding: "utf8", timeout: 10000 })
        const token = out.replace(/\n$/, "")
        return token || null
    } catch {
        return null   // not stored, keyring locked/unavailable, secret-tool missing - all just "not configured"
    }
}
function secretToolClear() {
    try { execFileSync(SECRET_TOOL_BIN, ["clear", ...SECRET_ATTRS], { timeout: 10000 }) } catch {}
}

export function readHaConfig() {
    let raw
    try {
        raw = JSON.parse(readFileSync(HA_CONFIG_PATH, "utf8"))
    } catch {
        return null
    }
    if (!raw || typeof raw !== "object" || !raw.baseUrl) return null
    let token = secretToolLookup()
    // One-time migration from the pre-keyring format (<= 0.4.3), where the
    // token lived in this file directly: move it into the keyring and
    // rewrite the file without it, silently, so existing installs don't
    // have to re-enter their token after this update.
    if (!token && raw.token) {
        try {
            secretToolStore(raw.token)
            token = raw.token
            writeFileSync(HA_CONFIG_PATH, JSON.stringify({ baseUrl: raw.baseUrl, verifyTls: !!raw.verifyTls }, null, 2) + "\n")
        } catch {
            token = raw.token   // keyring unavailable this run - keep working from the legacy file rather than lock the user out
        }
    }
    if (!token) return null
    return { baseUrl: raw.baseUrl, verifyTls: !!raw.verifyTls, token }
}

// `cfg` = { baseUrl, token, verifyTls }. The token goes to the keyring
// first; ha.json (non-secret) is a plain, ordinary config file.
export function writeHaConfig(cfg) {
    secretToolStore(cfg.token)
    mkdirSync(HA_CONFIG_DIR, { recursive: true })
    writeFileSync(HA_CONFIG_PATH, JSON.stringify({ baseUrl: cfg.baseUrl, verifyTls: !!cfg.verifyTls }, null, 2) + "\n")
}

export function deleteHaConfig() {
    secretToolClear()
    try { unlinkSync(HA_CONFIG_PATH) } catch {}
}

// A generous ceiling, not a target: David's real /api/states dump (~1800
// entities across HA OS + a large Zigbee2MQTT fleet) is well under 1MB of
// JSON. This exists so a misbehaving or compromised HA endpoint streaming
// an unbounded response can't grow this process's memory without limit -
// the socket timeout alone doesn't help against a slow, steady drip.
const MAX_HA_RESPONSE_BYTES = 32 * 1024 * 1024

// A plain `https.request` (not the global `fetch`/undici) so TLS
// verification behaves identically across the whole Node 18-24 support
// matrix - undici's cert-bypass mechanism differs across those versions.
function haRequest(cfg, path, { method = "GET", body, timeoutMs = 10000 } = {}) {
    return new Promise((resolve) => {
        let u
        try { u = new URL(cfg.baseUrl + path) } catch { resolve({ ok: false, status: 0, body: null, error: "bad base URL" }); return }
        const payload = body !== undefined ? JSON.stringify(body) : null
        const req = httpsRequest({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            rejectUnauthorized: cfg.verifyTls === true,
            timeout: timeoutMs,
            headers: {
                Authorization: "Bearer " + cfg.token,
                Accept: "application/json",
                ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let data = ""
            let bytes = 0
            let settled = false
            res.setEncoding("utf8")
            res.on("data", (c) => {
                if (settled) return
                bytes += Buffer.byteLength(c)
                if (bytes > MAX_HA_RESPONSE_BYTES) {
                    settled = true
                    req.destroy()
                    resolve({ ok: false, status: res.statusCode, body: null, error: "response too large" })
                    return
                }
                data += c
            })
            res.on("end", () => {
                if (settled) return
                settled = true
                let parsed = null
                try { parsed = data ? JSON.parse(data) : null } catch {}
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed, raw: data })
            })
        })
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: null, error: "timeout" }) })
        req.on("error", (e) => resolve({ ok: false, status: 0, body: null, error: String(e.message || e) }))
        if (payload) req.write(payload)
        req.end()
    })
}

export const haGetStates = (cfg) => haRequest(cfg, "/api/states")
export const haWhoAmI = (cfg) => haRequest(cfg, "/api/config")   // cheap, cheap way to validate a token
export const haCallService = (cfg, domain, service, data) =>
    haRequest(cfg, "/api/services/" + domain + "/" + service, { method: "POST", body: data || {} })

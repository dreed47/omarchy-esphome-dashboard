// Impure side of the ESPHome dashboard: mDNS discovery and TCP health probes.
// Kept apart from deviceLogic.mjs so the parsing/classification there stays
// pure and unit-testable.

import { execFile } from "node:child_process"
import { connect } from "node:net"
import { request as httpsRequest } from "node:https"
import { URL } from "node:url"
import { readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs"
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

// Every ESPHome device advertises this mDNS service for HA's native API.
export const avahiBrowseEsphome = () =>
    run("avahi-browse", ["-rtp", "_esphomelib._tcp"], { timeout: 8000 })

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
// The token lives in its own file, mode 600, separate from config.json.

const HA_CONFIG_DIR = join(homedir(), ".config", "omarchy", "esphome-dashboard")
const HA_CONFIG_PATH = join(HA_CONFIG_DIR, "ha.json")

export function haConfigPath() { return HA_CONFIG_PATH }

export function readHaConfig() {
    try {
        const raw = JSON.parse(readFileSync(HA_CONFIG_PATH, "utf8"))
        return (raw && typeof raw === "object" && raw.baseUrl && raw.token) ? raw : null
    } catch {
        return null
    }
}

// `cfg` = { baseUrl, token, verifyTls }. Written mode 600; the token never
// belongs in config.json, which a user might otherwise share or sync.
export function writeHaConfig(cfg) {
    mkdirSync(HA_CONFIG_DIR, { recursive: true })
    writeFileSync(HA_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
    try { chmodSync(HA_CONFIG_PATH, 0o600) } catch {}
}

export function deleteHaConfig() {
    try { unlinkSync(HA_CONFIG_PATH) } catch {}
}

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
            res.setEncoding("utf8")
            res.on("data", (c) => { data += c })
            res.on("end", () => {
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

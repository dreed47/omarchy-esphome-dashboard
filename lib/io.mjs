// Impure side of the ESPHome dashboard: mDNS discovery and TCP health probes.
// Kept apart from deviceLogic.mjs so the parsing/classification there stays
// pure and unit-testable.

import { execFile } from "node:child_process"
import { connect } from "node:net"
import { request as httpsRequest } from "node:https"
import { URL } from "node:url"
import {
    openSync, closeSync, readSync, writeSync, fstatSync, lstatSync, mkdirSync,
    chmodSync, unlinkSync, renameSync, fsyncSync, constants as fsConstants,
} from "node:fs"
import { randomBytes } from "node:crypto"
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
// The token lives in its own file, mode 600, separate from config.json.

const HA_CONFIG_DIR = join(homedir(), ".config", "omarchy", "esphome-dashboard")
const HA_CONFIG_PATH = join(HA_CONFIG_DIR, "ha.json")

// This file is a tiny {baseUrl,token,verifyTls} object - a few hundred
// bytes at most. A larger file at this path is not one we wrote; refuse it
// rather than reading it into memory.
const MAX_HA_CONFIG_BYTES = 64 * 1024

export function haConfigPath() { return HA_CONFIG_PATH }

// `O_NOFOLLOW` on the final path component (used everywhere below) refuses
// to follow a symlink planted exactly at ha.json/its temp file - but a
// plain pathname like ".../omarchy/esphome-dashboard/ha.json" is resolved
// component-by-component by the kernel, and O_NOFOLLOW does not apply to
// the intermediate components (".config", "omarchy",
// "esphome-dashboard"). If one of those were swapped for a symlink, a
// pathname-based mkdir/open/rename would still silently follow it.
//
// Node's core `fs` has no openat()/renameat()-relative-to-an-already-open-
// directory-descriptor API - the only way to close that fully - so this
// instead walks $HOME down to the target directory with `lstatSync` on
// each already-existing component, refusing to proceed if any of them is
// a symlink or not owned by this user. That narrows the race between
// "checked" and "used" to component creation only; it cannot eliminate it
// the way a held directory descriptor would. Exploiting what's left
// requires an attacker who can already write into one of these
// directories as this same Linux user - already code-execution parity
// with this process, at which point far easier attacks exist (reading
// this process's own memory, LD_PRELOAD, ptrace).
function verifyOwnedDir(path) {
    let st
    try { st = lstatSync(path) } catch { return "missing" }
    // lstat (not stat) means a symlink-to-a-real-directory still fails
    // isDirectory() here - exactly the case this needs to catch.
    if (!st.isDirectory()) return "not-a-real-directory"
    if (st.uid !== process.getuid()) return "not-owned-by-us"
    return "ok"
}
function verifyDirChainOrThrow(dir) {
    const home = homedir()
    if (dir !== home && !dir.startsWith(home + "/")) throw new Error("refusing to use " + dir + ": outside $HOME")
    const segments = dir === home ? [] : dir.slice(home.length + 1).split("/")
    let cur = home
    for (const seg of [null, ...segments]) {
        if (seg !== null) cur = join(cur, seg)
        const result = verifyOwnedDir(cur)
        if (result === "missing") return   // this and everything below it doesn't exist yet - fine, mkdirSync creates it fresh
        if (result !== "ok") throw new Error("refusing to use " + cur + ": " + result)
    }
}

// Reads/writes below never follow a symlink at HA_CONFIG_PATH itself
// (O_NOFOLLOW): this file holds the HA bearer token, and something else
// able to write into our own config directory could otherwise plant a
// symlink there to have us read from or clobber an arbitrary file this
// user owns.
export function readHaConfig() {
    try {
        verifyDirChainOrThrow(HA_CONFIG_DIR)
    } catch {
        return null
    }
    let fd
    try {
        fd = openSync(HA_CONFIG_PATH, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch {
        return null   // missing, a symlink, or unreadable - all just "not configured"
    }
    try {
        const st = fstatSync(fd)
        // Not a regular file, hardlinked from somewhere else (nlink > 1 -
        // another directory entry aliases this same inode), not ours,
        // group/other-readable, or suspiciously large: treat as absent
        // rather than trusting it.
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid()
            || (st.mode & 0o077) !== 0 || st.size > MAX_HA_CONFIG_BYTES) return null
        const buf = Buffer.alloc(st.size)
        readSync(fd, buf, 0, st.size, 0)
        const raw = JSON.parse(buf.toString("utf8"))
        return (raw && typeof raw === "object" && raw.baseUrl && raw.token) ? raw : null
    } catch {
        return null
    } finally {
        closeSync(fd)
    }
}

// `cfg` = { baseUrl, token, verifyTls }. The token never belongs in
// config.json, which a user might otherwise share or sync.
//
// Written atomically: build the new contents in a randomly-named temp file
// in the same directory (O_CREAT|O_EXCL so nothing can pre-plant that exact
// name, O_NOFOLLOW, mode 600 from creation so it's never briefly readable
// by anyone else), fsync the file's data before closing it, then rename it
// into place and fsync the containing directory so the rename itself is
// durable. A rename replaces whatever directory entry is at
// HA_CONFIG_PATH - including a symlink - rather than following it, so
// this can't be tricked into writing through one either.
export function writeHaConfig(cfg) {
    verifyDirChainOrThrow(HA_CONFIG_DIR.slice(0, HA_CONFIG_DIR.lastIndexOf("/")))
    mkdirSync(HA_CONFIG_DIR, { recursive: true, mode: 0o700 })
    try { chmodSync(HA_CONFIG_DIR, 0o700) } catch {}
    // Re-verify right up against the point of use, including the
    // directory we just created/touched - narrows, once more, the window
    // between check and use (see verifyDirChainOrThrow's comment).
    verifyDirChainOrThrow(HA_CONFIG_DIR)

    const body = JSON.stringify(cfg, null, 2) + "\n"
    const tmpPath = HA_CONFIG_PATH + ".tmp-" + randomBytes(8).toString("hex")
    const fd = openSync(
        tmpPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
    )
    try {
        writeSync(fd, body)
        fsyncSync(fd)
    } finally {
        closeSync(fd)
    }
    renameSync(tmpPath, HA_CONFIG_PATH)

    const dirFd = openSync(HA_CONFIG_DIR, fsConstants.O_RDONLY)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
}

export function deleteHaConfig() {
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

// Impure side of the ESPHome dashboard: mDNS discovery and TCP health probes.
// Kept apart from deviceLogic.mjs so the parsing/classification there stays
// pure and unit-testable.

import { execFile, execFileSync } from "node:child_process"
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

// Every child process this module spawns is tracked here so the CLI
// entrypoint can force-kill anything still running on its own SIGTERM/
// SIGINT (see killActiveChildren, called from bin/esphome-dashboard).
// execFile's own `timeout` option only kills a child via a JS timer
// running in THIS process - if this process is torn down first (e.g. the
// QML side gives up waiting and signals it), that timer never fires and
// the child would otherwise be orphaned.
const activeChildren = new Set()

export function killActiveChildren() {
    for (const child of activeChildren) {
        try { child.kill("SIGKILL") } catch {}
    }
}

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = execFile(
            cmd, args,
            { maxBuffer: 8 * 1024 * 1024, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", ...opts },
            (err, stdout) => { activeChildren.delete(child); resolve(err ? "" : stdout) }   // best-effort: no devices, no avahi -> just empty
        )
        activeChildren.add(child)
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
// The full config - baseUrl, verifyTls, and the token - now lives in the
// freedesktop Secret Service (gnome-keyring, a hard dependency of the
// `omarchy` package itself: see `pacman -Qi omarchy` and
// `pactree -r libsecret`, which shows libsecret -> gcr -> gnome-keyring ->
// omarchy - so this is guaranteed present, not an optional extra). That
// closes the question earlier rounds (0.4.2-0.4.5) kept circling back to:
// baseUrl controls where the keyring's bearer token gets sent, so a
// baseUrl that lived only in a directory-swappable file was still an
// integrity-sensitive redirect target even after the token itself moved
// into the keyring. Making the keyring the single source of truth for the
// whole config, not just the token, removes that redirect target rather
// than continuing to harden it.
//
// ha.json still exists as a best-effort, NON-authoritative local cache
// (so e.g. `haConfigPath()` has something to point at for a save
// confirmation message) but nothing ever trusts it to build an outgoing
// request - readHaConfig() only falls back to it during one-time
// migration from pre-0.4.6 installs, and even then every access goes
// through openLeafDirFd()'s pinned directory descriptor rather than
// re-resolving HA_CONFIG_DIR by name for each operation. Linux resolves
// `/proc/self/fd/<fd>/<name>` relative to the *already-open* directory
// fd, not by re-walking the pathname from `/` - that gives
// openat()/renameat()-relative-to-a-descriptor semantics from plain Node
// `fs`, no native addon needed, closing the check-then-use gap a
// separate lstat()-then-pathname-open() had left open through 0.4.5.

const HA_CONFIG_DIR = join(homedir(), ".config", "omarchy", "esphome-dashboard")
const HA_CONFIG_PATH = join(HA_CONFIG_DIR, "ha.json")
const MAX_HA_CONFIG_BYTES = 64 * 1024

export function haConfigPath() { return HA_CONFIG_PATH }

function verifyOwnedDir(path) {
    let st
    try { st = lstatSync(path) } catch { return "missing" }
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

// Opens `dir` as a directory fd we can pin every subsequent operation to,
// instead of re-resolving `dir` by name for each open/rename/unlink. The
// ancestor chain is lstat-verified first (as before - first-time creation
// still needs pathnames, an unavoidable one-time floor since you can't
// hold a descriptor to a directory that doesn't exist yet), then the leaf
// itself is opened with O_NOFOLLOW|O_DIRECTORY - which refuses a symlink
// or non-directory in a single syscall rather than a separate lstat
// followed by a re-resolved open - and the resulting fd is fstat-checked
// to confirm it's still ours. Every caller must close the returned fd.
function openLeafDirFd(dir) {
    verifyDirChainOrThrow(dir)
    const fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY)
    try {
        const st = fstatSync(fd)
        if (!st.isDirectory() || st.uid !== process.getuid()) {
            throw new Error("refusing to use " + dir + ": changed since verification")
        }
    } catch (e) {
        closeSync(fd)
        throw e
    }
    return fd
}

function readHaConfigFileRaw() {
    const dirFd = openLeafDirFd(HA_CONFIG_DIR)   // throws if refused; caller catches
    try {
        const fd = openSync(`/proc/self/fd/${dirFd}/ha.json`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        try {
            const st = fstatSync(fd)
            // This file holds no secret (baseUrl/verifyTls only, and only
            // as a non-authoritative cache) - the check that matters is
            // that nothing else can WRITE it (mode & 0o022: group/other
            // write bits), not that nothing else can read it. Requiring
            // group/other-unreadable too would reject a file written with
            // a plain 0644 default (e.g. by an older version of this
            // plugin, or hand-edited) for no integrity reason.
            if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid()
                || (st.mode & 0o022) !== 0 || st.size > MAX_HA_CONFIG_BYTES) return null
            const buf = Buffer.alloc(st.size)
            readSync(fd, buf, 0, st.size, 0)
            return JSON.parse(buf.toString("utf8"))
        } finally {
            closeSync(fd)
        }
    } finally {
        closeSync(dirFd)
    }
}

// Written atomically against a single pinned directory fd rather than a
// freshly re-resolved HA_CONFIG_DIR pathname per operation: a
// randomly-named temp file (O_EXCL so nothing can pre-plant that exact
// name, O_NOFOLLOW, mode 600 from creation), fsynced before close, then
// renamed into place via that same fd (a rename replaces whatever is at
// ha.json - including a symlink - rather than following it), then the
// directory itself fsynced too. Every path below the initial mkdirSync
// goes through `/proc/self/fd/<dirFd>/...`, which the kernel resolves
// relative to the fd's pinned inode, not by re-walking the name - a
// directory swap after openLeafDirFd() returns cannot redirect any of
// these operations the way a plain pathname-based rename/open could.
function writeHaConfigFileRaw(obj) {
    verifyDirChainOrThrow(HA_CONFIG_DIR.slice(0, HA_CONFIG_DIR.lastIndexOf("/")))
    mkdirSync(HA_CONFIG_DIR, { recursive: true, mode: 0o700 })
    try { chmodSync(HA_CONFIG_DIR, 0o700) } catch {}

    const dirFd = openLeafDirFd(HA_CONFIG_DIR)
    try {
        const body = JSON.stringify(obj, null, 2) + "\n"
        const tmpName = "ha.json.tmp-" + randomBytes(8).toString("hex")
        const tmpProcPath = `/proc/self/fd/${dirFd}/${tmpName}`
        const fd = openSync(
            tmpProcPath,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600,
        )
        try {
            writeSync(fd, body)
            fsyncSync(fd)
        } finally {
            closeSync(fd)
        }
        renameSync(tmpProcPath, `/proc/self/fd/${dirFd}/ha.json`)
        fsyncSync(dirFd)
    } finally {
        closeSync(dirFd)
    }
}

// Trusted absolute path (owned by the `libsecret` package - see above),
// not ambient-PATH resolution, same convention as every other executable
// this plugin spawns.
const SECRET_TOOL_BIN = "/usr/bin/secret-tool"
const SECRET_ATTRS = ["application", "io.github.dreed47.esphome-dashboard", "account", "ha-token"]
const SECRET_LABEL = "ESPHome Dashboard: Home Assistant token"

// The keyring item now holds the full config - baseUrl, verifyTls, and
// token - as one JSON blob, not just the bare token. That makes the
// keyring authoritative for baseUrl too, so a directory swap of this
// plugin's own config dir can no longer redirect where the bearer token
// gets sent - there's nothing left in that dir for such a swap to
// control on the read path.
function secretToolStore(cfg) {
    execFileSync(SECRET_TOOL_BIN, ["store", "--label=" + SECRET_LABEL, ...SECRET_ATTRS], {
        input: JSON.stringify({ baseUrl: cfg.baseUrl, verifyTls: !!cfg.verifyTls, token: cfg.token }),
        timeout: 10000,
    })
}
// Returns the raw secret-tool stdout (either the new JSON-blob format or,
// for an item stored by 0.4.4/0.4.5, a bare token string), or null if
// nothing is stored / the keyring is locked or unavailable / secret-tool
// is missing - all just "not configured".
function secretToolLookupRaw() {
    try {
        const out = execFileSync(SECRET_TOOL_BIN, ["lookup", ...SECRET_ATTRS], { encoding: "utf8", timeout: 10000 })
        const trimmed = out.replace(/\n$/, "")
        return trimmed || null
    } catch {
        return null
    }
}
function secretToolClear() {
    try { execFileSync(SECRET_TOOL_BIN, ["clear", ...SECRET_ATTRS], { timeout: 10000 }) } catch {}
}

export function readHaConfig() {
    const secretRaw = secretToolLookupRaw()

    if (secretRaw) {
        let blob = null
        try { blob = JSON.parse(secretRaw) } catch {}
        if (blob && typeof blob === "object" && blob.token && blob.baseUrl) {
            // Refresh the non-authoritative local cache so haConfigPath()
            // has something recent to point at; failure here is harmless
            // since nothing reads this file as a source of truth anymore.
            try { writeHaConfigFileRaw({ baseUrl: blob.baseUrl, verifyTls: !!blob.verifyTls }) } catch {}
            return { baseUrl: blob.baseUrl, verifyTls: !!blob.verifyTls, token: blob.token }
        }

        // One-time migration from the 0.4.4/0.4.5 format: the keyring item
        // was just the bare token string, and baseUrl/verifyTls still
        // lived in ha.json. Read that through the hardened fd-pinned path
        // above (still integrity-checked, since this is the last time
        // this file's baseUrl is trusted for anything).
        let raw
        try { raw = readHaConfigFileRaw() } catch { return null }
        if (!raw || typeof raw !== "object" || !raw.baseUrl) return null
        const cfg = { baseUrl: raw.baseUrl, verifyTls: !!raw.verifyTls, token: secretRaw }
        try { secretToolStore(cfg) } catch {}   // upgrade to the full-blob format; best-effort, retried next read on failure
        return cfg
    }

    // No keyring item at all - maybe a pre-0.4.4 install where the token
    // still lives in ha.json directly. `raw` is read through the hardened
    // path, so trusting `raw.token` here is no less safe than trusting
    // the rest of `raw` (baseUrl) already is. If the migration itself
    // can't complete (keyring unavailable this run), do NOT fall back to
    // using the legacy plaintext token - that would keep the original
    // exposure alive indefinitely instead of just for one run. Fail
    // closed instead: report "not configured" and let the next
    // successful `readHaConfig` (or a fresh save) retry it.
    let raw
    try { raw = readHaConfigFileRaw() } catch { return null }
    if (!raw || typeof raw !== "object" || !raw.baseUrl || !raw.token) return null
    const cfg = { baseUrl: raw.baseUrl, verifyTls: !!raw.verifyTls, token: raw.token }
    try {
        secretToolStore(cfg)
        writeHaConfigFileRaw({ baseUrl: cfg.baseUrl, verifyTls: cfg.verifyTls })   // strip the token out of the cache file
    } catch {
        return null
    }
    return cfg
}

// `cfg` = { baseUrl, token, verifyTls }. The full config goes to the
// keyring first (authoritative); ha.json is then refreshed as a
// best-effort, non-authoritative cache only - its failure no longer
// blocks a save, since nothing depends on it to reach the endpoint.
export function writeHaConfig(cfg) {
    secretToolStore(cfg)
    try { writeHaConfigFileRaw({ baseUrl: cfg.baseUrl, verifyTls: !!cfg.verifyTls }) } catch {}
}

export function deleteHaConfig() {
    secretToolClear()
    try {
        const dirFd = openLeafDirFd(HA_CONFIG_DIR)
        try { unlinkSync(`/proc/self/fd/${dirFd}/ha.json`) } finally { closeSync(dirFd) }
    } catch {}
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

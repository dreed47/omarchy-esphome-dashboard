// Impure side of the ESPHome dashboard: mDNS discovery and TCP health probes.
// Kept apart from deviceLogic.mjs so the parsing/classification there stays
// pure and unit-testable.

import { execFile } from "node:child_process"
import { connect } from "node:net"

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

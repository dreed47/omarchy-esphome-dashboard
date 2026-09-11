import { test } from "node:test"
import assert from "node:assert/strict"

import {
    parseEsphomeDevices, mergeHealth, deviceAlerts, worstSeverity, summaryLine,
    shortMac, platformGlyph, diffOnline, onlineMap, parseArgs,
    stepMissCounts, isConfirmedOffline, worstSeverityConfirmed, summaryLineConfirmed,
} from "../deviceLogic.mjs"

// Real `avahi-browse -rtp _esphomelib._tcp` output, captured off a live
// network: a plain user config (no project fields), seen on two interfaces
// (dedup case), and a "project" build (ratgdo) which adds project_name/
// project_version/package_import_url.
const AVAHI_OUT = [
    "+;wlp2s0;IPv4;stairlights;_esphomelib._tcp;local",
    "+;enp1s0;IPv4;stairlights;_esphomelib._tcp;local",
    "=;wlp2s0;IPv4;stairlights;_esphomelib._tcp;local;stairlights.local;192.168.86.191;6053;\"api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256\" \"network=wifi\" \"board=lolin_s2_mini\" \"platform=ESP32\" \"mac=84fce6c66bc0\" \"config_hash=01f4733f\" \"version=2026.8.2\" \"friendly_name=StairLights\"",
    "=;enp1s0;IPv4;stairlights;_esphomelib._tcp;local;stairlights.local;192.168.86.191;6053;\"api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256\" \"network=wifi\" \"board=lolin_s2_mini\" \"platform=ESP32\" \"mac=84fce6c66bc0\" \"config_hash=01f4733f\" \"version=2026.8.2\" \"friendly_name=StairLights\"",
    "=;wlp2s0;IPv4;ratgdov25i-cca36a;_esphomelib._tcp;local;ratgdov25i-cca36a.local;192.168.86.166;6053;\"package_import_url=github://ratgdo/esphome-ratgdo/v25iboard.yaml@main\" \"project_version=2.5i\" \"project_name=ratgdo.v25iboard_secplus2\" \"api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256\" \"network=wifi\" \"board=d1_mini\" \"platform=ESP8266\" \"mac=24d7ebcca36a\" \"config_hash=7abe3fa1\" \"version=2026.8.2\" \"friendly_name=ratgdo\"",
    // fabricated: a device with no psk configured, to exercise the warning
    "=;wlp2s0;IPv4;garage-fans;_esphomelib._tcp;local;garage-fans.local;192.168.86.213;6053;\"api_encryption=\" \"network=wifi\" \"board=esp32dev\" \"platform=ESP32\" \"mac=aabbccddeeff\" \"config_hash=deadbeef\" \"version=2026.8.2\" \"friendly_name=Garage Fans\"",
].join("\n")

test("parseEsphomeDevices: dedups across interfaces, sorts by friendly name", () => {
    const list = parseEsphomeDevices(AVAHI_OUT)
    assert.equal(list.length, 3)
    assert.deepEqual(list.map((d) => d.name), ["garage-fans", "ratgdov25i-cca36a", "stairlights"])
})

test("parseEsphomeDevices: plain config has no project fields", () => {
    const d = parseEsphomeDevices(AVAHI_OUT).find((x) => x.name === "stairlights")
    assert.equal(d.friendlyName, "StairLights")
    assert.equal(d.address, "192.168.86.191")
    assert.equal(d.port, 6053)
    assert.equal(d.mac, "84fce6c66bc0")
    assert.equal(d.platform, "ESP32")
    assert.equal(d.board, "lolin_s2_mini")
    assert.equal(d.espVersion, "2026.8.2")
    assert.equal(d.apiEncrypted, true)
    assert.equal(d.projectName, "")
})

test("parseEsphomeDevices: project build carries project fields", () => {
    const d = parseEsphomeDevices(AVAHI_OUT).find((x) => x.name === "ratgdov25i-cca36a")
    assert.equal(d.projectName, "ratgdo.v25iboard_secplus2")
    assert.equal(d.projectVersion, "2.5i")
    assert.equal(d.platform, "ESP8266")
})

test("parseEsphomeDevices: empty api_encryption -> not encrypted", () => {
    const d = parseEsphomeDevices(AVAHI_OUT).find((x) => x.name === "garage-fans")
    assert.equal(d.apiEncrypted, false)
})

test("parseEsphomeDevices: garbage in, empty out", () => {
    assert.deepEqual(parseEsphomeDevices(""), [])
    assert.deepEqual(parseEsphomeDevices("not avahi output at all\n+;incomplete"), [])
})

test("mergeHealth + deviceAlerts + worstSeverity", () => {
    const devices = parseEsphomeDevices(AVAHI_OUT)
    const health = {
        "192.168.86.191": { online: true, latencyMs: 12 },
        "192.168.86.166": { online: false, latencyMs: -1 },
        // garage-fans (213) missing from the map -> defaults to offline
    }
    const merged = mergeHealth(devices, health).map((d) => ({ ...d, alerts: deviceAlerts(d) }))

    const stair = merged.find((d) => d.name === "stairlights")
    assert.equal(stair.online, true)
    assert.equal(stair.latencyMs, 12)
    assert.deepEqual(stair.alerts, [])

    const ratgdo = merged.find((d) => d.name === "ratgdov25i-cca36a")
    assert.equal(ratgdo.online, false)
    assert.deepEqual(ratgdo.alerts, [{ code: "offline", text: "offline", severity: "error" }])

    const fans = merged.find((d) => d.name === "garage-fans")
    assert.equal(fans.online, false)   // no health entry = treated as offline, not crashed

    assert.equal(worstSeverity(merged), "error")   // ratgdo/fans offline outranks the encryption warning
})

test("worstSeverity: unencrypted-but-online is a warning, not an error", () => {
    const devices = [
        { online: true, apiEncrypted: false },
        { online: true, apiEncrypted: true },
    ]
    assert.equal(worstSeverity(devices), "warn")
})

test("worstSeverity: all clean", () => {
    assert.equal(worstSeverity([{ online: true, apiEncrypted: true }]), "ok")
    assert.equal(worstSeverity([]), "ok")
})

test("summaryLine", () => {
    assert.equal(summaryLine([]), "No ESPHome devices found")
    assert.equal(summaryLine([{ online: true }]), "1 device · all online")
    assert.equal(summaryLine([{ online: true }, { online: true }]), "2 devices · all online")
    assert.equal(summaryLine([{ online: true }, { online: false }]), "2 devices · 1 offline")
    assert.equal(summaryLine([{ online: false }, { online: false }]), "2 devices · 2 offline")
})

test("shortMac / platformGlyph", () => {
    assert.equal(shortMac("84fce6c66bc0"), "6BC0")
    assert.equal(shortMac(""), "")
    assert.notEqual(platformGlyph("ESP32"), platformGlyph("unknown"))
})

test("diffOnline / onlineMap", () => {
    const cur = [{ name: "a", online: false }, { name: "b", online: true }, { name: "c", online: true }]
    const prev = { a: true, b: false, c: true }   // a went offline, b came online, c unchanged
    const { wentOffline, cameOnline } = diffOnline(cur, prev)
    assert.deepEqual(wentOffline.map((d) => d.name), ["a"])
    assert.deepEqual(cameOnline.map((d) => d.name), ["b"])
    assert.deepEqual(onlineMap(cur), { a: false, b: true, c: true })
})

test("stepMissCounts: increments on offline, resets on online", () => {
    const devices = [{ name: "a", online: false }, { name: "b", online: true }]
    const c1 = stepMissCounts(devices, {})
    assert.deepEqual(c1, { a: 1, b: 0 })
    const c2 = stepMissCounts(devices, c1)
    assert.deepEqual(c2, { a: 2, b: 0 })
    const c3 = stepMissCounts([{ name: "a", online: true }, { name: "b", online: true }], c2)
    assert.deepEqual(c3, { a: 0, b: 0 })
})

test("isConfirmedOffline: needs `threshold` consecutive misses", () => {
    assert.equal(isConfirmedOffline("a", { a: 1 }, 2), false)
    assert.equal(isConfirmedOffline("a", { a: 2 }, 2), true)
    assert.equal(isConfirmedOffline("a", { a: 5 }, 2), true)
    assert.equal(isConfirmedOffline("unknown", {}, 2), false)
})

test("worstSeverityConfirmed / summaryLineConfirmed: one missed poll from a sleepy node is not an alarm", () => {
    const devices = [
        { name: "tagreader-garage", online: false, apiEncrypted: false },
        { name: "stairlights", online: true, apiEncrypted: true },
    ]
    const oneMiss = { "tagreader-garage": 1 }   // below the threshold of 2
    assert.equal(worstSeverityConfirmed(devices, oneMiss, 2), "ok")
    assert.equal(summaryLineConfirmed(devices, oneMiss, 2), "2 devices · all online")

    const confirmed = { "tagreader-garage": 3 }   // past threshold
    assert.equal(worstSeverityConfirmed(devices, confirmed, 2), "error")
    assert.equal(summaryLineConfirmed(devices, confirmed, 2), "2 devices · 1 offline")
})

test("parseArgs", () => {
    assert.deepEqual(parseArgs(["status", "--json"]), { cmd: "status", positionals: [], json: true })
    const a = parseArgs(["ping", "--host", "192.168.1.5", "--port", "6053", "--timeout", "500"])
    assert.equal(a.cmd, "ping"); assert.equal(a.host, "192.168.1.5")
    assert.equal(a.port, "6053"); assert.equal(a.timeout, "500")
    assert.equal(parseArgs(["--help"]).help, true)
    assert.equal(parseArgs(["-h"]).help, true)
    assert.equal(parseArgs([]).cmd, "")
    assert.throws(() => parseArgs(["status", "--bogus"]), /unknown option/)
})

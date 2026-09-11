import { test } from "node:test"
import assert from "node:assert/strict"

import {
    parseUpdateEntities, matchDeviceForEntity, mergeFirmwareUpdates,
    haConfigured, normalizeBaseUrl,
} from "../haLogic.mjs"

// Shaped like a real `GET /api/states` response, restricted to what an
// ESPHome-integrated device's update entity carries.
const STATES = [
    {
        entity_id: "update.stairlights_firmware",
        state: "on",
        attributes: {
            friendly_name: "StairLights Firmware",
            installed_version: "2026.8.2",
            latest_version: "2026.9.0",
            title: "ESPHome",
            release_url: "https://esphome.io/changelog/2026.9.0.html",
            release_summary: "Bugfixes",
            in_progress: false,
        },
    },
    {
        entity_id: "update.ratgdo_firmware",
        state: "off",
        attributes: {
            friendly_name: "ratgdo Firmware",
            installed_version: "2026.8.2",
            latest_version: "2026.8.2",
        },
    },
    {
        entity_id: "update.unrelated_addon_update",
        state: "unavailable",
        attributes: { friendly_name: "Some Add-on" },
    },
    { entity_id: "sensor.stairlights_wifi_signal", state: "-52", attributes: {} },
]

const DEVICES = [
    { name: "stairlights", friendlyName: "StairLights" },
    { name: "ratgdov25i-cca36a", friendlyName: "ratgdo" },
    { name: "garage-fans", friendlyName: "Garage Fans" },
]

test("parseUpdateEntities: only update.* entities, shapes attributes", () => {
    const list = parseUpdateEntities(STATES)
    assert.equal(list.length, 3)
    const stair = list.find((e) => e.entityId === "update.stairlights_firmware")
    assert.equal(stair.available, true)
    assert.equal(stair.installedVersion, "2026.8.2")
    assert.equal(stair.latestVersion, "2026.9.0")
    assert.equal(stair.releaseUrl, "https://esphome.io/changelog/2026.9.0.html")
    const ratgdo = list.find((e) => e.entityId === "update.ratgdo_firmware")
    assert.equal(ratgdo.available, false)
    const unrel = list.find((e) => e.entityId === "update.unrelated_addon_update")
    assert.equal(unrel.unavailable, true)
})

test("parseUpdateEntities: garbage/empty input", () => {
    assert.deepEqual(parseUpdateEntities([]), [])
    assert.deepEqual(parseUpdateEntities(null), [])
    assert.deepEqual(parseUpdateEntities([{ entity_id: "sensor.x", state: "1" }]), [])
})

test("matchDeviceForEntity: matches by mDNS name inside the entity_id slug", () => {
    const list = parseUpdateEntities(STATES)
    const stair = list.find((e) => e.entityId === "update.stairlights_firmware")
    const d = matchDeviceForEntity(stair, DEVICES)
    assert.equal(d.name, "stairlights")
})

test("matchDeviceForEntity: matches ratgdo by friendlyName when entity slug doesn't contain the mDNS name", () => {
    const list = parseUpdateEntities(STATES)
    const ratgdo = list.find((e) => e.entityId === "update.ratgdo_firmware")
    // entity_id slug "ratgdofirmware" does not contain the mDNS name
    // "ratgdov25iccc36a" (it's the other way around), but does match the
    // device's own friendlyName "ratgdo".
    const d = matchDeviceForEntity(ratgdo, DEVICES)
    assert.equal(d.name, "ratgdov25i-cca36a")
})

test("matchDeviceForEntity: no match returns null", () => {
    const list = parseUpdateEntities(STATES)
    const unrel = list.find((e) => e.entityId === "update.unrelated_addon_update")
    assert.equal(matchDeviceForEntity(unrel, DEVICES), null)
})

test("mergeFirmwareUpdates: attaches firmwareUpdate, null when unmatched", () => {
    const entities = parseUpdateEntities(STATES)
    const merged = mergeFirmwareUpdates(DEVICES, entities)
    const stair = merged.find((d) => d.name === "stairlights")
    assert.equal(stair.firmwareUpdate.available, true)
    assert.equal(stair.firmwareUpdate.latestVersion, "2026.9.0")
    const fans = merged.find((d) => d.name === "garage-fans")
    assert.equal(fans.firmwareUpdate, null)
})

test("haConfigured", () => {
    assert.equal(haConfigured({ baseUrl: "https://x", token: "t" }), true)
    assert.equal(haConfigured({ baseUrl: "https://x" }), false)
    assert.equal(haConfigured({ token: "t" }), false)
    assert.equal(haConfigured(null), false)
})

test("normalizeBaseUrl", () => {
    assert.equal(normalizeBaseUrl("homeassistant.local:8123"), "https://homeassistant.local:8123")
    assert.equal(normalizeBaseUrl("https://homeassistant.local:8123/"), "https://homeassistant.local:8123")
    assert.equal(normalizeBaseUrl("http://192.168.1.5:8123"), "http://192.168.1.5:8123")
    assert.equal(normalizeBaseUrl(""), "")
})

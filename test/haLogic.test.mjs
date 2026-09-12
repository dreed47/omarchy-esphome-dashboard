import { test } from "node:test"
import assert from "node:assert/strict"

import {
    parseUpdateEntities, matchDeviceForEntity, mergeFirmwareUpdates,
    parseButtonEntities, isRiskyButton, mergeButtons,
    haConfigured, normalizeBaseUrl, isLoopbackBaseUrl,
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

// Shaped from a real David-provided /api/states dump: tag readers, a ratgdo
// garage door controller, and unrelated button.* entities from the rest of
// the house that must NOT get pulled in.
const BUTTON_STATES = [
    {
        entity_id: "button.tagreader_bedroom_restart",
        state: "unknown",
        attributes: { friendly_name: "Tagreader-Bedroom TagReader Bedroom Restart", device_class: "restart" },
    },
    {
        entity_id: "button.write_tag_random",
        state: "unknown",
        attributes: { friendly_name: "Tagreader-Bedroom Write Tag Random" },
    },
    {
        entity_id: "button.clean_tag",
        state: "unknown",
        attributes: { friendly_name: "Tagreader-Bedroom Clean Tag" },
    },
    {
        entity_id: "button.cancel_writing",
        state: "unknown",
        attributes: { friendly_name: "Tagreader-Bedroom Cancel writing" },
    },
    {
        entity_id: "button.ratgdov25i_cca36a_restart",
        state: "unknown",
        attributes: { friendly_name: "Garage Door Restart", device_class: "restart" },
    },
    {
        entity_id: "button.ratgdov25i_cca36a_toggle_door",
        state: "unknown",
        attributes: { friendly_name: "Garage Door Toggle door" },
    },
    {
        entity_id: "button.ratgdov25i_cca36a_query_status",
        state: "unknown",
        attributes: { friendly_name: "Garage Door Query status" },
    },
    {
        entity_id: "button.ratgdov25i_cca36a_sync",
        state: "unknown",
        attributes: { friendly_name: "Garage Door Sync" },
    },
    // Unrelated house entities that happen to also be button.* - must not
    // attach to any ESPHome device.
    { entity_id: "button.living_room_tablet_reboot", state: "unknown", attributes: { friendly_name: "Living Room Tablet Reboot" } },
]

const BUTTON_DEVICES = [
    { name: "tagreader-bedroom", friendlyName: "Tagreader-Bedroom" },
    // mDNS friendly name is just "ratgdo" - HA's own button friendly_names
    // use "Garage Door" instead, which isn't derivable from the device
    // record at all, only from the buttons' own shared word-prefix.
    { name: "ratgdov25i-cca36a", friendlyName: "ratgdo" },
    { name: "stairlights", friendlyName: "StairLights" },
]

test("parseButtonEntities: only button.* entities", () => {
    const list = parseButtonEntities(BUTTON_STATES)
    assert.equal(list.length, 9)
    assert.equal(parseButtonEntities([]).length, 0)
    assert.equal(parseButtonEntities(null).length, 0)
})

test("isRiskyButton: physical/destructive actions are risky, routine ones aren't", () => {
    assert.equal(isRiskyButton({ entityId: "button.ratgdov25i_cca36a_toggle_door" }), true)
    assert.equal(isRiskyButton({ entityId: "button.write_tag_random" }), true)
    assert.equal(isRiskyButton({ entityId: "button.clean_tag" }), true)
    assert.equal(isRiskyButton({ entityId: "button.cancel_writing" }), true)
    assert.equal(isRiskyButton({ entityId: "button.ratgdov25i_cca36a_restart" }), false)
    assert.equal(isRiskyButton({ entityId: "button.ratgdov25i_cca36a_query_status" }), false)
    assert.equal(isRiskyButton({ entityId: "button.ratgdov25i_cca36a_sync" }), false)
})

test("mergeButtons: attaches cleaned labels to the right device, ignores unrelated entities", () => {
    const entities = parseButtonEntities(BUTTON_STATES)
    const merged = mergeButtons(BUTTON_DEVICES, entities)

    const tagreader = merged.find((d) => d.name === "tagreader-bedroom")
    const labels = tagreader.buttons.map((b) => b.label).sort()
    assert.deepEqual(labels, ["Cancel writing", "Clean Tag", "Restart", "Write Tag Random"])

    const ratgdo = merged.find((d) => d.name === "ratgdov25i-cca36a")
    const ratgdoLabels = ratgdo.buttons.map((b) => b.label).sort()
    assert.deepEqual(ratgdoLabels, ["Query status", "Restart", "Sync", "Toggle door"])
    const toggle = ratgdo.buttons.find((b) => b.entityId === "button.ratgdov25i_cca36a_toggle_door")
    assert.equal(toggle.risky, true)
    const restart = ratgdo.buttons.find((b) => b.entityId === "button.ratgdov25i_cca36a_restart")
    assert.equal(restart.risky, false)

    // Device with no matching buttons at all gets an empty array, not undefined.
    const stair = merged.find((d) => d.name === "stairlights")
    assert.deepEqual(stair.buttons, [])
})

test("normalizeBaseUrl", () => {
    assert.equal(normalizeBaseUrl("homeassistant.local:8123"), "https://homeassistant.local:8123")
    assert.equal(normalizeBaseUrl("https://homeassistant.local:8123/"), "https://homeassistant.local:8123")
    assert.equal(normalizeBaseUrl("http://192.168.1.5:8123"), "http://192.168.1.5:8123")
    assert.equal(normalizeBaseUrl(""), "")
})

test("isLoopbackBaseUrl: only loopback addresses qualify for --insecure", () => {
    assert.equal(isLoopbackBaseUrl("https://127.0.0.1:8123"), true)
    assert.equal(isLoopbackBaseUrl("https://127.5.9.200:8123"), true)   // all of 127.0.0.0/8
    assert.equal(isLoopbackBaseUrl("https://localhost:8123"), true)
    assert.equal(isLoopbackBaseUrl("https://LOCALHOST:8123"), true)
    assert.equal(isLoopbackBaseUrl("https://[::1]:8123"), true)
    assert.equal(isLoopbackBaseUrl("https://homeassistant.local:8123"), false)
    assert.equal(isLoopbackBaseUrl("https://192.168.1.5:8123"), false)
    assert.equal(isLoopbackBaseUrl("https://ha.reedweb.net"), false)
    assert.equal(isLoopbackBaseUrl("not a url"), false)
    assert.equal(isLoopbackBaseUrl(""), false)
})

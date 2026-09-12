import QtQuick
import Quickshell
import Quickshell.Io

// Headless half of ESPHome Dashboard: polls `bin/esphome-dashboard status
// --json` on a timer, publishes the result for the bar pill / popup to read,
// and raises desktop notifications when a device goes offline, comes back,
// or is seen for the first time.
//
// All mDNS/network access is in the CLI (bin/esphome-dashboard). This file
// only spawns it, parses its JSON, debounces flaky devices, and calls
// omarchy-notification-send.
//
// Settings: the bar widget's shell.json entry wins; anything unset there
// falls back to ~/.config/omarchy/esphome-dashboard/config.json, then to
// built-in defaults (see manifest.json barWidget.defaults).
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string pluginId: "io.github.dreed47.esphome-dashboard"

  // ---- paths ------------------------------------------------------
  readonly property string pluginDir: decodeURIComponent(
    String(Qt.resolvedUrl(".")).replace(/^file:\/\//, ""))
  readonly property string cli: pluginDir + "bin/esphome-dashboard"

  // Trusted absolute executables, not ambient-PATH lookups. This process's
  // PATH is inherited from the long-lived shell and isn't something this
  // plugin controls; resolving "node"/"omarchy-notification-send" by name
  // would let anything earlier on that PATH intercept the HA access token
  // (sent to `node` over stdin) or spoof/suppress device-action calls.
  // Both are fixed, package-owned locations: `nodejs` -> /usr/bin/node
  // (the plugin's own documented dependency, "omarchy pkg add nodejs"),
  // `omarchy` -> /usr/bin/omarchy-notification-send. If either binary isn't
  // actually there, the spawn fails and this plugin already treats that as
  // cliMissing / a no-op notification - it fails closed, not open.
  readonly property string nodeBin: "/usr/bin/node"
  readonly property string notifyBin: "/usr/bin/omarchy-notification-send"
  readonly property string home: String(Quickshell.env("HOME") || "")
  readonly property string confDir: {
    var xdg = String(Quickshell.env("XDG_CONFIG_HOME") || "")
    return (xdg !== "" ? xdg : home + "/.config") + "/omarchy/esphome-dashboard"
  }
  readonly property string configFile: confDir + "/config.json"

  // ---- config: shell.json entry over config.json over defaults ----
  property var configJsonRaw: ({})
  readonly property var shellEntry: {
    var sc = shell ? shell.shellConfig : null
    if (!sc) return ({})
    try {
      if (sc.bar && sc.bar.layout) {
        var secs = ["left", "center", "right"]
        for (var s = 0; s < secs.length; s++) {
          var arr = sc.bar.layout[secs[s]] || []
          for (var i = 0; i < arr.length; i++)
            if (arr[i] && String(arr[i].id) === root.pluginId) return arr[i]
        }
      }
      var plugs = sc.plugins || []
      for (var j = 0; j < plugs.length; j++)
        if (plugs[j] && String(plugs[j].id) === root.pluginId) return plugs[j]
    } catch (e) {}
    return ({})
  }

  function pick(key, dflt) {
    if (shellEntry && shellEntry[key] !== undefined && shellEntry[key] !== null && shellEntry[key] !== "")
      return shellEntry[key]
    if (configJsonRaw && configJsonRaw[key] !== undefined && configJsonRaw[key] !== null && configJsonRaw[key] !== "")
      return configJsonRaw[key]
    return dflt
  }
  function isOn(v) { return v === true || v === "on" || v === "true" || v === 1 || v === "1" }

  readonly property var cfg: ({
    pollSeconds: Math.max(10, parseInt(pick("pollSeconds", 30), 10) || 30),
    healthTimeoutMs: Math.max(300, parseInt(pick("healthTimeoutMs", 1500), 10) || 1500),
    confirmMisses: Math.max(1, parseInt(pick("confirmMisses", 2), 10) || 2),
    notify: isOn(pick("notify", "on")),
    notifyTypes: String(pick("notifyTypes", "offline,online,new,firmware")).toLowerCase(),
    notifyTimeoutSeconds: parseInt(pick("notifyTimeoutSeconds", 0), 10) || 0,
    hideNames: String(pick("hideNames", "")),
    debug: isOn(pick("debug", "off"))
  })
  function wants(type) {
    var t = cfg.notifyTypes
    return cfg.notify && (t === "all" || t.split(",").map(function (x) { return x.trim() }).indexOf(type) !== -1)
  }
  readonly property var hiddenSet: {
    var out = {}
    var parts = cfg.hideNames.split(",")
    for (var i = 0; i < parts.length; i++) { var n = parts[i].trim(); if (n !== "") out[n] = true }
    return out
  }

  FileView {
    path: root.configFile
    watchChanges: true
    printErrors: false
    onLoaded: { try { root.configJsonRaw = JSON.parse(text()) || ({}) } catch (e) { root.configJsonRaw = ({}) } }
    onLoadFailed: root.configJsonRaw = ({})
    onFileChanged: reload()
  }

  // ---- live state the pill / popup read -------------------------
  property bool cliMissing: false
  property var devices: []
  property int deviceCount: 0
  property int onlineCount: 0
  property string worstState: "ok"     // confirmed: ok | warn | error
  property string summary: ""
  property double lastPollMs: 0
  property bool haConnected: false   // Phase 2: a Home Assistant token is saved and reachable
  property bool haConfigured: false  // a token is saved, whether or not it answered this poll
  property string haBaseUrl: ""      // never the token itself
  property bool haVerifyTls: false

  // ---- persisted debounce / notification baseline ----------------
  PersistentProperties {
    id: st
    reloadableId: "omarchy-esphome-dashboard"
    property bool baselined: false
    property string missCountsJson: "{}"     // { deviceName: consecutive misses }
    property string confirmedJson: "{}"      // { deviceName: "online"|"offline" } last confirmed state notified on
    property string everSeenJson: "[]"       // every device name ever discovered
    property string notifiedFirmwareJson: "{}"   // { deviceName: latestVersion already notified about }
  }
  function jparse(s, dflt) { try { var v = JSON.parse(s); return v === null ? dflt : v } catch (e) { return dflt } }

  readonly property int pollMs: cfg.pollSeconds * 1000
  property double pollStartedMs: 0

  // ---- poll ---------------------------------------------------
  function poll() {
    if (statusProc.running) {
      if (Date.now() - root.pollStartedMs < 20000) return
      statusProc.running = false
    }
    root.pollStartedMs = Date.now()
    statusProc.command = [root.nodeBin, root.cli, "status", "--timeout", String(root.cfg.healthTimeoutMs), "--json"]
    statusProc.running = true
  }
  Timer {
    id: settleTimer
    interval: 1500
    repeat: false
    onTriggered: root.poll()
  }
  function pollSoon() { Qt.callLater(root.poll); settleTimer.restart() }

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var body = String(text || "").trim()
        if (body === "") return
        var s
        try { s = JSON.parse(body) } catch (e) {
          if (root.cfg.debug) console.log("[esphome-dashboard] status parse error", e)
          return
        }
        root.cliMissing = false
        root.applyStatus(s)
      }
    }
    onExited: function (code) {
      if (code !== 0 && root.deviceCount === 0 && !root.everPolled) root.cliMissing = true
    }
  }
  property bool everPolled: false

  function applyStatus(s) {
    root.everPolled = true
    var raw = (s.devices || []).filter(function (d) { return !root.hiddenSet[d.name] })

    var missCounts = jparse(st.missCountsJson, {})
    var nextMiss = {}
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i]
      var prev = missCounts[d.name] || 0
      nextMiss[d.name] = d.online ? 0 : prev + 1
    }
    st.missCountsJson = JSON.stringify(nextMiss)

    var threshold = root.cfg.confirmMisses
    function confirmedOffline(name) { return (nextMiss[name] || 0) >= threshold }

    var sev = "ok"
    var offlineCount = 0
    for (var j = 0; j < raw.length; j++) {
      var dd = raw[j]
      if (!dd.online && confirmedOffline(dd.name)) { sev = "error"; offlineCount++ }
      else if (dd.online && !dd.apiEncrypted && sev !== "error") sev = "warn"
    }

    root.devices = raw
    root.deviceCount = raw.length
    root.onlineCount = raw.filter(function (x) { return x.online }).length
    root.worstState = sev
    root.summary = raw.length === 0 ? "No ESPHome devices found"
      : (raw.length + (raw.length === 1 ? " device" : " devices")
         + (offlineCount === 0 ? " · all online" : " · " + offlineCount + (offlineCount === 1 ? " offline" : " offline")))
    root.lastPollMs = Date.now()
    root.haConnected = s.haConnected === true
    root.haConfigured = s.haConfigured === true
    root.haBaseUrl = String(s.haBaseUrl || "")
    root.haVerifyTls = s.haVerifyTls === true

    root.diffAndNotify(raw, nextMiss, threshold)
  }

  // ---- diff confirmed state across polls -> notifications ---------
  function diffAndNotify(raw, missCounts, threshold) {
    var everSeen = jparse(st.everSeenJson, [])
    var confirmed = jparse(st.confirmedJson, {})

    if (!st.baselined) {
      // First poll ever: adopt silently, nothing "new" or "recovered" yet.
      var seed = everSeen.slice()
      var confirmedSeed = {}
      var firmwareSeed = {}
      for (var i = 0; i < raw.length; i++) {
        if (seed.indexOf(raw[i].name) === -1) seed.push(raw[i].name)
        confirmedSeed[raw[i].name] = raw[i].online ? "online" : "offline"
        if (raw[i].firmwareUpdate && raw[i].firmwareUpdate.available)
          firmwareSeed[raw[i].name] = raw[i].firmwareUpdate.latestVersion
      }
      st.everSeenJson = JSON.stringify(seed)
      st.confirmedJson = JSON.stringify(confirmedSeed)
      st.notifiedFirmwareJson = JSON.stringify(firmwareSeed)
      st.baselined = true
      return
    }

    var nextConfirmed = Object.assign({}, confirmed)
    var notifiedFw = jparse(st.notifiedFirmwareJson, {})
    for (var k = 0; k < raw.length; k++) {
      var d = raw[k]
      var isNew = everSeen.indexOf(d.name) === -1
      if (isNew) {
        everSeen.push(d.name)
        if (root.wants("new"))
          root.notify("normal", "", "New ESPHome device", d.friendlyName + " (" + d.address + ")", false)
        nextConfirmed[d.name] = d.online ? "online" : "offline"
        if (d.firmwareUpdate && d.firmwareUpdate.available) notifiedFw[d.name] = d.firmwareUpdate.latestVersion
        continue
      }

      var wasConfirmed = confirmed[d.name] || "online"
      if (d.online && wasConfirmed !== "online") {
        nextConfirmed[d.name] = "online"
        if (root.wants("online"))
          root.notify("normal", "", d.friendlyName + " is back online", d.address, false)
      } else if (!d.online && wasConfirmed !== "offline" && (missCounts[d.name] || 0) >= threshold) {
        nextConfirmed[d.name] = "offline"
        if (root.wants("offline"))
          root.notify("critical", "", d.friendlyName + " went offline", d.address, true)
      }

      // Firmware update newly available (Phase 2, only once per version).
      var fw = d.firmwareUpdate
      if (fw && fw.available && notifiedFw[d.name] !== fw.latestVersion) {
        notifiedFw[d.name] = fw.latestVersion
        if (root.wants("firmware"))
          root.notify("normal", "", d.friendlyName + " update available",
            (fw.installedVersion || "?") + " " + String.fromCharCode(0x2192) + " " + fw.latestVersion, false)
      } else if (!fw || !fw.available) {
        delete notifiedFw[d.name]   // installed (or entity vanished) - free to notify again next time
      }
    }
    st.everSeenJson = JSON.stringify(everSeen)
    st.confirmedJson = JSON.stringify(nextConfirmed)
    st.notifiedFirmwareJson = JSON.stringify(notifiedFw)
  }

  // ---- notification queue -------------------------------------
  property var notifyQueue: []
  function notify(urgency, glyph, headline, body, isError) {
    if (!cfg.notify) return
    var cmd = [root.notifyBin, "--app-name", "ESPHome Dashboard", "-u", urgency]
    if (glyph) { cmd.push("-g"); cmd.push(String(glyph)) }
    if (cfg.notifyTimeoutSeconds > 0) { cmd.push("-t"); cmd.push(String(cfg.notifyTimeoutSeconds * 1000)) }
    cmd.push(String(headline))
    if (body) cmd.push(String(body))
    notifyQueue.push(cmd)
    pumpNotify()
  }
  Process { id: notifyProc; onExited: root.pumpNotify() }
  function pumpNotify() {
    if (notifyProc.running || notifyQueue.length === 0) return
    notifyProc.command = notifyQueue.shift()
    notifyProc.running = true
  }

  // ---- timer ------------------------------------------------
  Timer {
    interval: root.pollMs
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.poll()
  }

  // ---- Phase 2: ask Home Assistant to install a pending update ------
  //
  // The same thing pressing "Install" in HA's own UI does
  // (`update.install`); nothing talks to the ESPHome Dashboard directly.
  // The device reboots to apply it, so the popup asks for a confirm click
  // before calling this.
  property string installState: "idle"   // idle | installing | error
  property string installError: ""
  Process {
    id: installProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var e = String(text).trim().replace(/^esphome-dashboard:\s*/, "")
        if (e !== "") root.installError = e
      }
    }
    onExited: function (code) {
      root.installState = code === 0 ? "idle" : "error"
      Qt.callLater(root.pollSoon)
    }
  }
  function installUpdate(entityId) {
    if (installProc.running || !entityId) return
    root.installState = "installing"
    root.installError = ""
    installProc.command = [root.nodeBin, root.cli, "update-install", "--entity", String(entityId), "--json"]
    installProc.running = true
  }

  // ---- Phase 2: press a Home Assistant button.* entity ---------------
  //
  // Generic action buttons surfaced from HA (device restart, ratgdo's
  // "toggle door", tag-reader NFC actions, ...) - same `button.press`
  // service HA's own UI calls. One in flight at a time, same as installs;
  // `buttonPressEntity` says which one so the popup can spinner just that
  // button rather than the whole card.
  property string buttonPressState: "idle"   // idle | pressing | error
  property string buttonPressEntity: ""
  property string buttonPressError: ""
  Process {
    id: buttonPressProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var e = String(text).trim().replace(/^esphome-dashboard:\s*/, "")
        if (e !== "") root.buttonPressError = e
      }
    }
    onExited: function (code) {
      root.buttonPressState = code === 0 ? "idle" : "error"
      if (code === 0) root.buttonPressEntity = ""
      Qt.callLater(root.pollSoon)
    }
  }
  function pressButton(entityId) {
    if (buttonPressProc.running || !entityId) return
    root.buttonPressState = "pressing"
    root.buttonPressEntity = String(entityId)
    root.buttonPressError = ""
    buttonPressProc.command = [root.nodeBin, root.cli, "press-button", "--entity", String(entityId), "--json"]
    buttonPressProc.running = true
  }

  // ---- Phase 2: save / forget the Home Assistant token, from the popup's
  // settings form --------------------------------------------------
  //
  // The token goes over the process's stdin, never argv - the same way
  // Omarchy's own Wi-Fi panel hands an 802.1X password to its helper
  // (Process.write(), no explicit stdin close needed: the CLI reads one
  // line and moves on rather than waiting for the pipe to end).
  property string haSaveState: "idle"   // idle | saving | saved | error
  property string haSaveError: ""
  Process {
    id: haTokenProc
    property string pendingToken: ""
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var e = String(text).trim().replace(/^esphome-dashboard:\s*/, "")
        if (e !== "") root.haSaveError = e
      }
    }
    onStarted: { write(pendingToken + "\n"); pendingToken = "" }
    onExited: function (code) {
      root.haSaveState = code === 0 ? "saved" : "error"
      Qt.callLater(root.pollSoon)
    }
  }
  // `token` may be "" to mean "keep the current one" (changing just the
  // base URL or the TLS setting) - only meaningful when already configured.
  function saveHaToken(baseUrl, token, verifyTls) {
    if (haTokenProc.running || !baseUrl) return
    if (!token && !root.haConfigured) return
    root.haSaveState = "saving"
    root.haSaveError = ""
    haTokenProc.pendingToken = String(token || "")
    var cmd = [root.nodeBin, root.cli, "ha-token", "--base-url", String(baseUrl)]
    if (!verifyTls) cmd.push("--insecure")
    haTokenProc.command = cmd
    haTokenProc.running = true
  }

  Process {
    id: haForgetProc
    onExited: function () { root.haSaveState = "idle"; Qt.callLater(root.pollSoon) }
  }
  function forgetHaToken() {
    if (haForgetProc.running) return
    haForgetProc.command = [root.nodeBin, root.cli, "ha-forget"]
    haForgetProc.running = true
  }

  // ---- IPC --------------------------------------------------
  IpcHandler {
    target: "esphome-dashboard"
    function refresh(): void { Qt.callLater(root.poll) }
    function installUpdate(entityId: string): void { root.installUpdate(entityId) }
    function pressButton(entityId: string): void { root.pressButton(entityId) }
    function saveHaToken(baseUrl: string, token: string): void { root.saveHaToken(baseUrl, token, false) }
    function forgetHaToken(): void { root.forgetHaToken() }
    function status(): string {
      return JSON.stringify({
        cliMissing: root.cliMissing,
        devices: root.devices,
        deviceCount: root.deviceCount,
        onlineCount: root.onlineCount,
        worstState: root.worstState,
        summary: root.summary,
        lastPollMs: root.lastPollMs,
        haConnected: root.haConnected,
        haConfigured: root.haConfigured,
        haBaseUrl: root.haBaseUrl,
        haVerifyTls: root.haVerifyTls,
        installState: root.installState,
        buttonPressState: root.buttonPressState,
        buttonPressEntity: root.buttonPressEntity,
        buttonPressError: root.buttonPressError,
        haSaveState: root.haSaveState,
        haSaveError: root.haSaveError
      })
    }
  }
}

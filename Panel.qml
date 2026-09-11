import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Popup for the ESPHome Dashboard bar pill: every device found over mDNS,
// its online/offline state, platform/board, firmware version, latency, and
// an unencrypted-API warning where it applies.
//
// All live numbers come from the headless Service.qml via `serviceFor`;
// "Refresh" asks it to poll again right away.
Panel {
  id: root
  moduleName: "io.github.dreed47.esphome-dashboard"
  ipcTarget: "io.github.dreed47.esphome-dashboard"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  property bool openedFromHotkey: false
  property bool popoutSwitchClosing: false

  readonly property string pluginId: "io.github.dreed47.esphome-dashboard"
  readonly property var svc: root.bar && root.bar.shell ? root.bar.shell.serviceFor(pluginId) : null

  readonly property bool cliMissing: svc ? svc.cliMissing === true : false
  readonly property var devices: svc ? (svc.devices || []) : []
  readonly property int deviceCount: svc ? (svc.deviceCount || 0) : 0
  readonly property int onlineCount: svc ? (svc.onlineCount || 0) : 0
  readonly property string worstState: svc ? String(svc.worstState || "ok") : "ok"
  readonly property string summary: svc ? String(svc.summary || "") : ""

  readonly property string chipGlyph: String.fromCharCode(0xf2db)
  readonly property string bullet: String.fromCharCode(0x2022)

  // ---- bar-pill tooltip / right-click text ----------------------
  readonly property string tooltip: {
    if (cliMissing) return "ESPHome Dashboard — Node.js is required (omarchy pkg add nodejs)"
    return "ESPHome Dashboard — " + (summary || "no devices")
  }
  function statusLines() {
    if (cliMissing) return ["ESPHome Dashboard", "Node.js is required: omarchy pkg add nodejs"]
    var out = ["ESPHome Dashboard — " + summary]
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i]
      var line = (d.online ? "* " : "  ") + d.friendlyName + "  " + d.address
      if (d.alerts && d.alerts.length) line += "  — " + d.alerts[0].text
      out.push(line)
    }
    return out
  }
  readonly property string statusGlyph: chipGlyph

  function refresh() { if (svc) svc.pollSoon() }
  onOpenedChanged: if (root.opened) root.refresh()

  // ---- "Nm ago" ticker while open ---------------------------
  property double nowMs: Date.now()
  Timer {
    interval: 30000
    repeat: true
    running: root.opened
    onRunningChanged: if (running) root.nowMs = Date.now()
    onTriggered: root.nowMs = Date.now()
  }
  Timer {
    interval: 15000
    repeat: true
    running: root.opened
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // ---- lifecycle -------------------------------------------
  function open() { openedFromHotkey = false; root.controller.show(); root.refresh() }
  function openFromHotkey() { openedFromHotkey = true; root.controller.show(); root.refresh() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? root.close() : root.openFromHotkey() }
  function closeForPopoutSwitch() {
    root.popoutSwitchClosing = true
    root.controller.hide()
    Qt.callLater(function () { root.popoutSwitchClosing = false })
  }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refresh() }
  }

  // ---- UI -------------------------------------------------
  readonly property color fg: root.bar ? root.bar.foreground : "#e0e0e0"
  readonly property color dim: root.bar ? Qt.darker(fg, 1.5) : "#909090"
  readonly property color urgent: root.bar ? root.bar.urgent : "#e06c75"
  readonly property string mono: root.bar ? root.bar.fontFamily : "monospace"

  function sevColor(sev) {
    return sev === "error" ? root.urgent : (sev === "warn" ? Color.accent : root.dim)
  }
  function relTime(ms) {
    if (!ms) return ""
    var s = Math.floor((root.nowMs - ms) / 1000)
    if (s < 45) return "just now"
    if (s < 3600) return Math.floor(s / 60) + "m ago"
    if (s < 86400) return Math.floor(s / 3600) + "h ago"
    return Math.floor(s / 86400) + "d ago"
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(col.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Column {
        id: col
        width: parent.width
        spacing: Style.space(12)

        // ---- header ------------------------------------------
        Item {
          width: parent.width
          height: Style.space(24)
          Text {
            id: titleText
            anchors.left: parent.left
            anchors.leftMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            text: root.chipGlyph + "  ESPHome Dashboard"
            color: root.fg
            font.family: root.mono
            font.pixelSize: Style.font.body
            font.bold: true
          }
          Text {
            anchors.left: titleText.right
            anchors.right: refreshBtn.left
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            horizontalAlignment: Text.AlignRight
            text: root.summary
            elide: Text.ElideLeft
            color: root.sevColor(root.worstState)
            font.family: root.mono
            font.pixelSize: Style.font.caption
          }
          Text {
            id: refreshBtn
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            text: String.fromCharCode(0xf021)   // fa-refresh
            color: refreshArea.containsMouse ? Color.accent : root.dim
            font.family: root.mono
            font.pixelSize: Style.font.caption
            MouseArea {
              id: refreshArea
              anchors.fill: parent
              anchors.margins: -Style.space(5)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.refresh()
            }
          }
        }

        // ---- node-missing banner ------------------------------
        Rectangle {
          visible: root.cliMissing
          width: parent.width
          height: visible ? nodeMsg.implicitHeight + Style.space(14) : 0
          radius: Style.cornerRadius
          color: "transparent"
          border.width: 1
          border.color: root.urgent
          Text {
            id: nodeMsg
            x: Style.space(10); y: Style.space(7)
            width: parent.width - Style.space(20)
            wrapMode: Text.WordWrap
            text: "Node.js is required and was not found.\nInstall it with:  omarchy pkg add nodejs"
            color: root.fg
            font.family: root.mono
            font.pixelSize: Style.font.caption
          }
        }

        // ---- device list ---------------------------------------
        Column {
          visible: !root.cliMissing
          width: parent.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            text: "DEVICES"
            color: root.dim
            font.family: root.mono
            font.pixelSize: Style.font.caption
            font.letterSpacing: 1
          }

          Text {
            visible: root.devices.length === 0
            width: parent.width
            text: "No ESPHome devices found on the network yet."
            color: root.dim
            font.family: root.mono
            font.pixelSize: Style.font.caption
          }

          Repeater {
            model: root.devices
            Rectangle {
              required property var modelData
              width: col.width
              height: dRow.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: "transparent"
              border.width: 1
              border.color: Qt.darker(root.fg, 1.8)

              Column {
                id: dRow
                x: Style.space(8)
                y: Style.space(6)
                width: parent.width - Style.space(16)
                spacing: Style.space(2)

                Row {
                  width: parent.width
                  spacing: Style.space(6)
                  Rectangle {
                    width: Style.space(7); height: Style.space(7)
                    radius: width / 2
                    anchors.verticalCenter: parent.verticalCenter
                    color: modelData.online
                      ? ((modelData.alerts && modelData.alerts.some(function (a) { return a.severity === "warn" }))
                         ? Color.accent : "#5fb85f")
                      : root.urgent
                  }
                  Text {
                    text: modelData.friendlyName
                    color: root.fg
                    font.family: root.mono
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, parent.width - Style.space(120))
                    anchors.verticalCenter: parent.verticalCenter
                  }
                  Text {
                    text: modelData.platform + (modelData.board ? "/" + modelData.board : "")
                    color: root.dim
                    font.family: root.mono
                    font.pixelSize: Style.font.caption - 2
                    elide: Text.ElideRight
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                Text {
                  width: parent.width
                  text: modelData.address + "  " + root.bullet + "  v" + modelData.espVersion
                    + (modelData.online ? "  " + root.bullet + "  " + modelData.latencyMs + "ms" : "")
                  color: modelData.online ? root.dim : root.urgent
                  font.family: root.mono
                  font.pixelSize: Style.font.caption - 1
                }

                Text {
                  visible: modelData.projectName !== ""
                  width: parent.width
                  text: modelData.projectName + (modelData.projectVersion ? " " + modelData.projectVersion : "")
                  color: Qt.darker(root.dim, 1.1)
                  font.family: root.mono
                  font.pixelSize: Style.font.caption - 2
                  elide: Text.ElideRight
                }

                Repeater {
                  model: modelData.alerts || []
                  Text {
                    required property var modelData
                    width: dRow.width
                    text: (modelData.severity === "error" ? String.fromCharCode(0xf071) + "  " : "")
                      + modelData.text
                    color: root.sevColor(modelData.severity)
                    font.family: root.mono
                    font.pixelSize: Style.font.caption - 1
                    wrapMode: Text.WordWrap
                    visible: modelData.code !== "offline"   // the dot + address line already say offline
                  }
                }
              }
            }
          }
        }

        // ---- footer -------------------------------------------
        Text {
          width: parent.width
          text: "options: ~/.config/omarchy/esphome-dashboard/config.json"
          color: Qt.darker(root.dim, 1.1)
          font.family: root.mono
          font.pixelSize: Style.font.caption - 2
          elide: Text.ElideRight
        }
      }
    }
  }
}

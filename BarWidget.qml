import QtQuick
import qs.Commons
import qs.Ui

// Bar pill for ESPHome Dashboard. Shows online/total device count; tints
// accent when an API is unencrypted, urgent when a device is confirmed
// offline. The popup (Panel.qml, loaded lazily) holds the device list. The
// headless Service.qml owns polling, debouncing, and notifications, and
// publishes the numbers this pill reads.
//
// Structure mirrors the Print Center / MakerWorld plugins so the bar's
// popout coordinator, hotkey routing, and popout-switch handoff behave the same.
BarWidget {
  id: root
  moduleName: "io.github.dreed47.esphome-dashboard"

  readonly property string pluginId: "io.github.dreed47.esphome-dashboard"
  readonly property var svc: bar && bar.shell ? bar.shell.serviceFor(pluginId) : null

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (svc) svc.pollSoon()
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }
  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }
  function notify() {
    if (!root.bar || !panelLoader.item) return
    var lines = panelLoader.item.statusLines()
    if (!lines || lines.length === 0) return
    var headline = lines.shift()
    var body = lines.join("\n")
    var cmd = "omarchy-notification-send --app-name 'ESPHome Dashboard' " + root.bar.shellQuote(headline)
    if (body !== "") cmd += " " + root.bar.shellQuote(body)
    root.bar.run(cmd)
  }

  // Popout contract expected by Bar.findPanelWidget / requestPopout.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  function open() { if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item && panelLoader.item.close) panelLoader.item.close() }
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  visible: panelLoader.item !== null
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  readonly property real openPanelIndicatorWidth: pillRow.implicitWidth

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }

  // ---- state from the service --------------------------------
  readonly property bool cliMissing: root.svc ? root.svc.cliMissing === true : false
  readonly property int deviceCount: root.svc ? (root.svc.deviceCount || 0) : 0
  readonly property int onlineCount: root.svc ? (root.svc.onlineCount || 0) : 0
  readonly property string worstState: root.svc ? String(root.svc.worstState || "ok") : "ok"

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    tooltipText: panelLoader.item ? panelLoader.item.tooltip : ""
    fixedWidth: pillRow.implicitWidth + Style.spaceReal(17)

    readonly property color accent: root.bar ? Color.accent : "#8ab4f8"
    readonly property color urgent: root.bar ? root.bar.urgent : "#e06c75"
    readonly property color dim: Qt.darker(button.foreground, 1.7)

    readonly property color pillColor: {
      if (root.cliMissing || root.worstState === "error") return button.urgent
      if (root.worstState === "warn") return button.accent
      return button.foreground
    }

    onPressed: function (b) {
      if (!root.bar) return
      if (b === Qt.RightButton) root.notify()
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }

    Row {
      id: pillRow
      anchors.centerIn: parent
      spacing: Style.spaceReal(5)

      // ESPHome's own mark (just the linework, no background - see
      // EsphomeMark.qml) tinted the same way the other bar icons are:
      // foreground normally, accent/urgent by fleet state.
      EsphomeMark {
        id: mark
        anchors.verticalCenter: parent.verticalCenter
        readonly property int side: Math.max(12, Math.round((root.bar ? root.bar.barSize : 30) * 0.62))
        width: side
        height: side
        color: button.pillColor
        opacity: root.cliMissing ? 0.5 : 1
      }

      // "online/total" count.
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.cliMissing && root.deviceCount > 0
        text: root.onlineCount + "/" + root.deviceCount
        color: button.pillColor
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        renderType: Text.NativeRendering
      }

      // Missing Node.js.
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.cliMissing
        text: "Node.js missing"
        color: button.pillColor
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        renderType: Text.NativeRendering
      }
    }
  }
}

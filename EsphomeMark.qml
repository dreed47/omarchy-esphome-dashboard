import QtQuick

// ESPHome's own icon mark - just the circuit-squiggle linework from their
// logo (github.com/esphome; artwork matches home-assistant/brands), with
// the brand's cyan house background dropped so it behaves like every other
// bar icon: one tintable shape, no background block, drawn as inline SVG so
// it stays crisp at bar size and follows the bar's own foreground/accent/
// urgent colors like a font glyph would.
Image {
  id: root

  property color color: "#e6e6e6"

  fillMode: Image.PreserveAspectFit
  smooth: true
  sourceSize.width: width > 0 ? Math.round(width * 2) : 40
  sourceSize.height: height > 0 ? Math.round(height * 2) : 40
  source: _svg(String(color))

  // The squiggle path only, lifted from ESPHome's logo SVG and cropped to
  // its own bounding box (the original sits inside a 240x240 house shape).
  readonly property string _path: "M160 78.66H80C76.68 78.66 74 81.34 74 84.66V234H86V90.66H154V102.66H104C100.68 102.66 98 105.34 98 108.66V132.66C98 135.98 100.68 138.66 104 138.66H154V150.66H104C100.68 150.66 98 153.34 98 156.66V180.66C98 183.98 100.68 186.66 104 186.66H154V198.66H104C100.68 198.66 98 201.34 98 204.66C98 207.98 100.68 210.66 104 210.66H160C163.32 210.66 166 207.98 166 204.66V180.66C166 177.34 163.32 174.66 160 174.66H110V162.66H160C163.32 162.66 166 159.98 166 156.66V132.66C166 129.34 163.32 126.66 160 126.66H110V114.66H160C163.32 114.66 166 111.98 166 108.66V84.66C166 81.34 163.32 78.66 160 78.66Z"

  function _svg(col) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="64 70 112 174">'
      + '<path d="' + root._path + '" fill="' + col + '"/></svg>'
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg)
  }
}

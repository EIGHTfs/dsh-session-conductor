    /** 会话卡图标内的矩形（24x24 viewBox 坐标系）。 */
    const ICON_RECT_X = 3;
    const ICON_RECT_Y = 4;
    const ICON_RECT_WIDTH = 18;
    const ICON_RECT_HEIGHT = 14;
    const ICON_RECT_RADIUS = 2;

    function SessionIcon(props) {
      const s = props.size || 16;
      return react_jsx_runtime.jsx("svg", {
        width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
        children: [
          react_jsx_runtime.jsx("rect", { x: ICON_RECT_X, y: ICON_RECT_Y, width: ICON_RECT_WIDTH, height: ICON_RECT_HEIGHT, rx: ICON_RECT_RADIUS }),
          react_jsx_runtime.jsx("path", { d: "M8 20h8" }),
          react_jsx_runtime.jsx("path", { d: "M12 18v2" }),
        ],
      });
    }


    function SessionIcon(props) {
      const s = props.size || 16;
      return react_jsx_runtime.jsx("svg", {
        width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
        children: [
          react_jsx_runtime.jsx("rect", { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
          react_jsx_runtime.jsx("path", { d: "M8 20h8" }),
          react_jsx_runtime.jsx("path", { d: "M12 18v2" }),
        ],
      });
    }


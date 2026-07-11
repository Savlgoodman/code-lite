import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import App from "./App";
import "./styles.css";
import { initializeTheme } from "./services/themeStore";

// 在 React 挂载前初始化主题（避免闪烁）
initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/**
 * 渲染进程入口
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// 皮肤与界面字号在 useTheme 模块加载时已按启动缓存写入 <html>，
// 这里不再硬编码任何主题 id，也不再与注册表里的默认皮肤重复定义。

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

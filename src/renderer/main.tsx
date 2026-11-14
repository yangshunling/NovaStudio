/**
 * 渲染进程入口
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installUnsavedGuardBridge } from "./lib/unsaved-guard";
import "./styles/index.css";

// 关窗 / 退出前的未保存询问：渲染层只负责应答，决定权在主进程
installUnsavedGuardBridge();

// 皮肤与界面字号在 useTheme 模块加载时已按启动缓存写入 <html>，
// 这里不再硬编码任何主题 id，也不再与注册表里的默认皮肤重复定义。

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

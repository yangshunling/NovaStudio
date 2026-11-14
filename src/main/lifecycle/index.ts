/**
 * 生产环境生命周期单例
 *
 * 状态机本身（machine.ts）不依赖 Electron，可以直接单测；
 * 这里只负责把落盘日志器注入进去，并统一对外导出。
 */

import { logLifecycle } from "../utils/lifecycle-log";
import { createLifecycle } from "./machine";

export * from "./machine";

/** 应用生命周期单例：启动完成与退出清理都以它为准 */
export const appLifecycle = createLifecycle(logLifecycle);

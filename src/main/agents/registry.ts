/**
 * Agent provider 注册表
 *
 * 自动收集 agents/<id>/index.ts 导出的 provider —— 与皮肤注册表同一套约定。
 *
 * 新增一个 Agent 只需两步：
 * 1. 新建 src/main/agents/<id>/ 包，其 index.ts 导出 `provider`
 * 2. 需要展示排序就在自己的 manifest.ts 里给 order
 *
 * 本文件、engine、ipc、UI 与共享契约均无需改动。
 *
 * 目录约定（只有 index.ts 是必需的）：
 *   index.ts     导出 provider（唯一入口）
 *   manifest.ts  静态元数据；被 index.ts 引用
 *   parse.ts     该 Agent 的字节/协议解析
 *   sessions.ts  该 Agent 的会话存储读写
 *
 * 展示顺序由 manifest.order 决定，与目录名顺序无关。
 */

import type { AgentProvider } from "./types";

/** Vite 静态收集：每个 provider 目录导出自己的 provider */
const modules = import.meta.glob<{ provider: AgentProvider }>("./*/index.ts", {
  eager: true,
});

const PROVIDERS: readonly AgentProvider[] = Object.values(modules).map((m) => m.provider);

if (PROVIDERS.length === 0) {
  throw new Error("未加载到任何 Agent provider，请检查 src/main/agents/<id>/index.ts");
}

/** 全部 provider，按 manifest.order 升序 */
export function listProviders(): AgentProvider[] {
  return [...PROVIDERS].sort((a, b) => a.manifest.order - b.manifest.order);
}

/** 按 manifest.id 查找 */
export function getProvider(id: string): AgentProvider | undefined {
  return PROVIDERS.find((p) => p.manifest.id === id);
}

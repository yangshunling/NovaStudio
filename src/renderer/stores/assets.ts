/**
 * 资产目录跨页共享（Skill / MCP / 知识库）
 *
 * 这三个列表都来自主进程的磁盘扫描：
 * - Skill：遍历 ~/.claude/skills 下每个技能目录并统计文件；
 * - MCP：读取并解析 ~/.claude.json；
 * - 知识库：递归统计每个知识库的 Markdown 文档。
 *
 * 侧栏切换会卸载 / 重新挂载页面，如果每次挂载都扫描一遍，来回切换就会
 * 反复做同一件事。这里收敛成单一来源：
 * - App 启动时 preloadAssets() 预热一次；
 * - 页面与员工抽屉的绑定标签页都读同一份数据，不再各自调用 ipc；
 * - 导入 / 新建 / 删除 / 保存等写操作后调用对应 load(true) 强制重扫；
 * - 顶栏「刷新」按钮同样走 load(true)。
 */

import { useCallback, useEffect } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { ipc } from "../lib/ipc";
import { toMessage } from "../lib/utils";
import type {
  KnowledgeBaseAsset,
  McpServerAsset,
  SkillAsset,
} from "@shared/types";

export interface AssetListState<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  /** 是否已成功加载过；用于跳过重复扫描 */
  loaded: boolean;
  /** force = true 时无视缓存重新扫描 */
  load: (force?: boolean) => Promise<void>;
  /** 就地更新（写操作后同步，无需重扫） */
  setItems: (next: T[] | ((prev: T[]) => T[])) => void;
}

function createAssetList<T>(fetcher: () => Promise<T[]>) {
  /** 扫描期间又收到 force 请求时，等本轮结束后补扫一次 */
  let queuedForce = false;

  return create<AssetListState<T>>((set, get) => ({
    items: [],
    loading: false,
    error: null,
    loaded: false,

    load: async (force = false) => {
      if (get().loading) {
        if (force) queuedForce = true;
        return;
      }
      if (get().loaded && !force) return;

      set({ loading: true, error: null });
      try {
        const items = await fetcher();
        set({ items, loaded: true, loading: false, error: null });
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
      }

      if (queuedForce) {
        queuedForce = false;
        void get().load(true);
      }
    },

    setItems: (next) =>
      set((s) => ({
        items:
          typeof next === "function"
            ? (next as (prev: T[]) => T[])(s.items)
            : next,
      })),
  }));
}

export const useSkillsStore = createAssetList<SkillAsset>(() =>
  ipc.listSkills(),
);

export const useMcpServersStore = createAssetList<McpServerAsset>(() =>
  ipc.listMcpServers(),
);

export const useKnowledgeBasesStore = createAssetList<KnowledgeBaseAsset>(() =>
  ipc.listKnowledgeBases(),
);

/**
 * 页面使用的统一入口：读取 store 并在首次挂载时按需加载。
 *
 * 启动预热通常已经完成，因此切换页面直接命中数据，不会再次扫描。
 */
export function useAssetCatalog<T>(
  store: UseBoundStore<StoreApi<AssetListState<T>>>,
): {
  items: T[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  setItems: AssetListState<T>["setItems"];
} {
  const items = store((s) => s.items);
  const loading = store((s) => s.loading);
  const error = store((s) => s.error);
  const load = store((s) => s.load);
  const setItems = store((s) => s.setItems);

  // loaded 后这里是无操作；未预热 / 上次失败时才会真正扫描
  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load(true);
  }, [load]);

  return { items, loading, error, reload, setItems };
}

/** App 启动时预热三个资产目录，之后的页面切换直接命中缓存 */
export function preloadAssets(): void {
  void useSkillsStore.getState().load();
  void useMcpServersStore.getState().load();
  void useKnowledgeBasesStore.getState().load();
}

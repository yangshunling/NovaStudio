/**
 * useAgentModels — 按 Agent 获取可选模型
 *
 * 模型列表来自主进程（各 provider 自己查 CLI / 接口），开销可能达到数秒，
 * 因此在这里做两层缓存：
 * - 模块级 Map：同一次应用运行内，切换员工 / 重复打开抽屉都复用结果
 * - inflight Map：并发请求同一 Agent 时只发一次 IPC
 *
 * 获取失败时缓存空数组，UI 会回退为手动输入；用户可点刷新重新获取。
 */

import { useCallback, useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { AgentModelOption } from "@shared/contracts/agent";

const cache = new Map<string, AgentModelOption[]>();
const inflight = new Map<string, Promise<AgentModelOption[]>>();

function load(agentId: string): Promise<AgentModelOption[]> {
  const cached = cache.get(agentId);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(agentId);
  if (pending) return pending;

  const request = ipc
    .listAgentModels(agentId)
    .then((models) => {
      cache.set(agentId, models);
      return models;
    })
    .catch(() => {
      cache.set(agentId, []);
      return [];
    })
    .finally(() => {
      inflight.delete(agentId);
    });

  inflight.set(agentId, request);
  return request;
}

interface ModelState {
  /** 这份结果属于哪个 Agent —— 用于避免切换 Agent 的瞬间串台 */
  agentId: string;
  models: AgentModelOption[];
  loading: boolean;
}

export function useAgentModels(agentId: string) {
  const [state, setState] = useState<ModelState>(() => ({
    agentId,
    models: cache.get(agentId) ?? [],
    loading: Boolean(agentId) && !cache.has(agentId),
  }));
  /** 刷新计数：递增即重新请求 */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!agentId) {
      setState({ agentId, models: [], loading: false });
      return;
    }

    const cached = cache.get(agentId);
    if (cached) {
      setState({ agentId, models: cached, loading: false });
      return;
    }

    let cancelled = false;
    setState({ agentId, models: [], loading: true });
    void load(agentId).then((models) => {
      if (cancelled) return;
      setState({ agentId, models, loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [agentId, revision]);

  const refresh = useCallback(() => {
    if (!agentId) return;
    cache.delete(agentId);
    inflight.delete(agentId);
    setState({ agentId, models: [], loading: true });
    setRevision((value) => value + 1);
  }, [agentId]);

  const matches = state.agentId === agentId;
  const models = matches ? state.models : (cache.get(agentId) ?? []);
  const loading = matches
    ? state.loading
    : Boolean(agentId) && !cache.has(agentId);

  return { models, loading, refresh };
}

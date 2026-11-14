/**
 * Agent 安装 —— 一键安装、实时日志、失败提示
 *
 * 与升级分开：安装只在「未检测到」时可用，成功后调用方刷新 Agent 列表，
 * 页面随即切换到配置视图。安装过程中的 npm 输出经 agent:install:progress
 * 推回，这里只负责累积最近的日志并给出失败原因。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";

export interface AgentInstallState {
  installing: boolean;
  /** 安装命令的实时输出（npm 进度等已由主进程去掉控制序列） */
  log: string;
  error: string | null;
  /** 安装成功的版本；用于成功态展示 */
  installedVersion: string | null;
  /** 执行安装：成功后刷新 Agent 列表，界面据此切到配置视图 */
  runInstall: () => Promise<void>;
  /** 清空上一次的失败信息与日志 */
  reset: () => void;
}

/** 与升级日志保持一致的上限，避免 npm 进度条把 DOM 撑爆 */
const LOG_LIMIT = 12_000;

export function useAgentInstall({
  agentId,
  refreshAgents,
}: {
  agentId: string;
  /** 安装成功后刷新 Agent 状态；成功后页面会自动切到配置视图 */
  refreshAgents: () => Promise<unknown>;
}): AgentInstallState {
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);

  // 安装命令的实时输出
  useEffect(
    () =>
      ipc.on.agentInstallProgress(({ agentId: id, chunk }) => {
        if (id !== agentId) return;
        setLog((prev) => (prev + chunk).slice(-LOG_LIMIT));
      }),
    [agentId],
  );

  /** 用 ref 防重入：状态更新是异步的，连点两次按钮时 state 还来不及变 */
  const installingRef = useRef(false);

  const reset = useCallback(() => {
    setError(null);
    setLog("");
    setInstalledVersion(null);
  }, []);

  const runInstall = useCallback(async () => {
    if (installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setError(null);
    setLog("");
    setInstalledVersion(null);

    try {
      const result = await ipc.installAgent(agentId);
      if (result.output) setLog(result.output);

      if (!result.ok) {
        const message = result.error ?? "安装失败";
        setError(message);
        toast.error(message);
        return;
      }

      setInstalledVersion(result.version ?? null);
      toast.success(
        result.version
          ? `Claude Code ${result.version} 安装完成`
          : "Claude Code 安装完成",
      );

      // 刷新失败不应把一次成功的安装误报成失败
      try {
        await refreshAgents();
      } catch {
        // 下次进入页面或手动检测时会重新拉取
      }
    } catch (err) {
      const message = toMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      installingRef.current = false;
      setInstalling(false);
    }
  }, [agentId, refreshAgents]);

  return { installing, log, error, installedVersion, runInstall, reset };
}

/**
 * Agent 版本升级 —— 检查、执行、实时日志
 *
 * 从 AgentsView 抽出的独立链路：版本检查、升级执行与进度日志只和
 * 「这个 Agent 装没装、什么版本」有关，与配置表单（Base URL / Key /
 * 模型别名）互不相干。整体挪出来后，AgentsView 只负责把结果接到界面上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentUpgradeCheck } from "@shared/contracts/agent";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";

export interface AgentUpgradeState {
  /** 最近一次检查结果；未检查 / 检查失败时为 null */
  check: AgentUpgradeCheck | null;
  checking: boolean;
  upgrading: boolean;
  /** 升级命令的实时输出（npm 进度等已由主进程去掉控制序列） */
  log: string;
  error: string | null;
  /** 检查最新版本；notify=true 时弹 toast（用户手动点击才弹） */
  checkUpgrade: (notify?: boolean) => Promise<void>;
  /** 执行升级：完成后刷新 Agent 状态并重新检查版本 */
  runUpgrade: () => Promise<void>;
  /** 版本状态文案 */
  statusText: string;
  /** 升级按钮是否禁用：已确认最新时禁用，检测失败仍允许尝试 */
  disabled: boolean;
}

export function useAgentUpgrade({
  agentId,
  active,
  installed,
  version,
  refreshAgents,
}: {
  agentId: string;
  /** 当前选中的就是这个 Agent，且已安装：才自动检查 */
  active: boolean;
  installed: boolean;
  /** 已安装版本号；变化时重新检查（升级完成后靠它触发） */
  version?: string | null;
  /** 升级成功后刷新 Agent 列表 */
  refreshAgents: () => Promise<unknown>;
}): AgentUpgradeState {
  const [check, setCheck] = useState<AgentUpgradeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);

  const checkUpgrade = useCallback(
    async (notify = false) => {
      setChecking(true);
      setError(null);
      try {
        const result = await ipc.checkAgentUpgrade(agentId);
        setCheck(result);
        if (notify) {
          if (result.error) {
            toast.info(result.error);
          } else if (result.updateAvailable) {
            toast.info(
              `发现新版本 ${result.latestVersion}，当前 ${result.installedVersion}`,
            );
          } else {
            toast.success(
              `Claude Code 已是最新版本（${result.installedVersion ?? "未知"}）`,
            );
          }
        }
      } catch (err) {
        const message = toMessage(err);
        setCheck(null);
        setError(message);
        if (notify) toast.error(message);
      } finally {
        setChecking(false);
      }
    },
    [agentId],
  );

  // 选中该 Agent 且已安装时自动检查一次；升级后版本变化会再次触发
  useEffect(() => {
    if (!active) {
      setCheck(null);
      setError(null);
      return;
    }
    void checkUpgrade();
  }, [active, version, checkUpgrade]);

  // 升级命令的实时输出
  useEffect(
    () =>
      ipc.on.agentUpgradeProgress(({ agentId: id, chunk }) => {
        if (id !== agentId) return;
        setLog((prev) => (prev + chunk).slice(-12_000));
      }),
    [agentId],
  );

  /** 用 ref 防重入：状态更新是异步的，连点两次按钮时 state 还来不及变 */
  const upgradingRef = useRef(false);

  const runUpgrade = useCallback(async () => {
    if (upgradingRef.current) return;
    upgradingRef.current = true;
    setUpgrading(true);
    setError(null);
    setLog("");
    try {
      const result = await ipc.upgradeAgent(agentId);
      if (result.output) setLog(result.output);

      if (result.ok) {
        toast.success(
          result.previousVersion &&
            result.version &&
            result.previousVersion !== result.version
            ? `Claude Code 已从 ${result.previousVersion} 升级到 ${result.version}`
            : "Claude Code 已是最新版本",
        );
      } else {
        const message = result.error ?? "升级失败";
        setError(message);
        toast.error(message);
      }

      // 状态刷新失败不应把一次成功的升级误报成失败
      try {
        await refreshAgents();
      } catch {
        // 下次进入页面或手动检测时会重新拉取
      }
      await checkUpgrade();
    } catch (err) {
      const message = toMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      upgradingRef.current = false;
      setUpgrading(false);
    }
  }, [agentId, checkUpgrade, refreshAgents]);

  const statusText = useMemo(() => {
    if (!installed) {
      return "未检测到 Claude Code，安装后可检查更新。";
    }
    if (error) return error;
    if (checking && !check) return "正在检查最新版本…";
    if (!check) return "尚未检查最新版本。";
    if (check.error) return check.error;
    if (check.updateAvailable) {
      return `发现新版本 ${check.latestVersion}，当前 ${check.installedVersion}。`;
    }
    return `已是最新版本（${check.installedVersion ?? "未知"}）。`;
  }, [installed, error, checking, check]);

  const disabled =
    !installed ||
    upgrading ||
    checking ||
    Boolean(check && !check.updateAvailable && !check.error);

  return {
    check,
    checking,
    upgrading,
    log,
    error,
    checkUpgrade,
    runUpgrade,
    statusText,
    disabled,
  };
}

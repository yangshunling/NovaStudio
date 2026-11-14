/**
 * Git 状态刷新触发器
 *
 * Git 状态无法只靠文件监听保持最新：
 * - 非递归 watch 只覆盖已展开目录，Agent 在深层目录写文件不会产生事件；
 * - 工作流节点编辑文件后也不会走聊天链路的 agent:done。
 *
 * 因此这里合并三类信号，统一做 400ms 防抖：
 * 1. Agent 聊天运行结束（覆盖「Agent 改文件」的主场景）；
 * 2. 工作流节点 / 运行结束；
 * 3. 已监听目录的文件变化（覆盖用户手工编辑）。
 * 面板/标签重新可见时还会立即刷新一次，吸收后台期间漏掉的事件。
 *
 * 只负责「何时刷」；具体拉取哪个接口、如何合并结果由调用方决定。
 */

import { useCallback, useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import {
  clearWatchSource,
  setWatchSource,
  subscribeWorkspaceChanges,
} from "../lib/file-watch";

/** 事件合并窗口：Agent 一次运行可能连续写多个文件 */
const DEBOUNCE_MS = 400;

export function useGitStatusRefresh(
  projectId: string | null,
  enabled: boolean,
  refresh: () => void,
  /** watch source 标识；同一项目可能有多个视图同时监听 */
  source: string,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback(() => {
    if (!projectId || !enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refreshRef.current();
    }, DEBOUNCE_MS);
  }, [projectId, enabled]);

  // 可见时登记根目录监听，并先刷一次（吸收隐藏期间的变更）
  useEffect(() => {
    if (!projectId || !enabled) return;
    setWatchSource(projectId, source, [""]);
    refreshRef.current();
    return () => {
      clearWatchSource(projectId, source);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [projectId, enabled, source]);

  useEffect(() => {
    if (!projectId || !enabled) return;
    const offs: Array<() => void> = [
      ipc.on.agentDone(schedule),
      ipc.on.agentAborted(schedule),
      ipc.on.workflowRunEvent((event) => {
        if (event.type === "run_finished" || event.type === "node_finished") {
          schedule();
        }
      }),
      subscribeWorkspaceChanges(projectId, schedule),
    ];
    return () => offs.forEach((off) => off());
  }, [projectId, enabled, schedule]);
}

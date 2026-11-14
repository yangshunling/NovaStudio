/**
 * 未保存改动登记表
 *
 * 渲染层不再用 `beforeunload` 决定「能不能关窗」：Electron 对它的处理是
 * 静默取消，用户看到的就是点 X 没反应。这里只登记「哪里还有未保存内容」，
 * 由主进程在关窗/退出前询问并弹原生确认框。
 *
 * 组件的用法只有一行：
 *   useUnsavedGuard({ id: "workflow:xxx", label: "工作流「回访」", dirty, save });
 *
 * 新增任何带草稿的编辑器（提示词、技能、MCP、知识库……）都复用同一套
 * 协议，不需要各自处理关窗逻辑。
 */

import { useEffect, useRef } from "react";
import { errorMessage } from "@shared/error";
import { confirmDialog } from "../stores/confirm";
import { ipc } from "./ipc";

interface Guard {
  label: string;
  dirty: boolean;
  save?: () => Promise<boolean>;
}

export interface UnsavedGuardOptions {
  /** 稳定标识；卸载时据此移除 */
  id: string;
  /** 展示给用户的名称，例如「工作流「客户回访」」 */
  label: string;
  /** 是否真的有未保存内容 */
  dirty: boolean;
  /** 提供后，退出确认框会多一个「保存并退出」 */
  save?: () => Promise<boolean>;
}

const guards = new Map<string, Guard>();

let bridgeInstalled = false;

/**
 * 登记一份未保存状态。
 *
 * 每次 dirty 变化都会替换登记项；save 通过 ref 读取，避免因为
 * useCallback 身份变化而反复重登记。
 */
export function useUnsavedGuard({
  id,
  label,
  dirty,
  save,
}: UnsavedGuardOptions): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    guards.set(id, {
      label,
      dirty,
      save: saveRef.current ? () => saveRef.current!() : undefined,
    });
    return () => {
      guards.delete(id);
    };
    // label 的变化由下面的 effect 同步，不参与重登记
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dirty]);

  useEffect(() => {
    const guard = guards.get(id);
    if (guard) guard.label = label;
  }, [id, label]);
}

/**
 * 站内导航（侧栏切页等）前的未保存确认。
 *
 * 关窗由主进程询问；页面切换发生在渲染层内部，因此也要在这里拦一次。
 * 没有登记任何未保存内容时直接放行，不打扰正常切页。
 */
export async function confirmLeaveUnsaved(): Promise<boolean> {
  const dirty = [...guards.values()].filter((guard) => guard.dirty);
  if (dirty.length === 0) return true;

  const labels = dirty.map((guard) => guard.label).filter(Boolean);
  const shown = labels.slice(0, 3).join("、");
  const message =
    labels.length > 3
      ? `${shown} 等 ${labels.length} 处尚未保存，离开会丢失这些修改。`
      : `${shown || "当前编辑内容"}尚未保存，离开会丢失这些修改。`;

  return confirmDialog({
    title: "有未保存的修改",
    message,
    confirmLabel: "放弃并离开",
    cancelLabel: "继续编辑",
    tone: "danger",
  });
}

/**
 * 挂上主进程 ↔ 渲染层的未保存协议。
 *
 * 必须在应用启动时调用一次（见 main.tsx）。没有登记项时也会应答，
 * 主进程据此判断「直接关闭」，不会多弹一次框。
 */
export function installUnsavedGuardBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  ipc.on.unsavedQuery(({ requestId }) => {
    const entries = [...guards.entries()]
      .filter(([, guard]) => guard.dirty)
      .map(([id, guard]) => ({
        id,
        label: guard.label,
        canSave: Boolean(guard.save),
      }));
    void ipc.answerUnsavedQuery({ requestId, entries }).catch(() => {
      // 主进程已按超时处理；这里失败无需再提示
    });
  });

  ipc.on.unsavedSaveAll(async ({ requestId }) => {
    const targets = [...guards.values()].filter(
      (guard) => guard.dirty && guard.save,
    );

    let error: string | null = null;
    for (const guard of targets) {
      try {
        const ok = await guard.save!();
        if (!ok) {
          error = "保存失败";
          break;
        }
      } catch (err) {
        error = errorMessage(err);
        break;
      }
    }

    await ipc
      .reportUnsavedSave({ requestId, ok: error === null, error })
      .catch(() => {
        // 主进程会在保存超时后自行放弃退出
      });
  });
}

/**
 * 未保存改动的关窗确认
 *
 * 设计约束（这是本次缺陷的根因，必须守住）：
 * **渲染进程不得拥有否决进程退出/关窗的能力。**
 *
 * Electron 对 `beforeunload` 的处理是「渲染层阻止 → 静默取消关闭」，
 * 既不弹浏览器确认框，也不报错，用户只会看到点 X 没反应。因此：
 *   - 渲染层不再注册 beforeunload，只登记「哪里还有未保存内容」；
 *   - 主进程在 `close` 事件里向渲染层询问一次，自己弹原生对话框；
 *   - 询问有超时：渲染进程忙/崩时按「没有未保存」处理，绝不能因此关不掉窗口。
 */

import { BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { randomUUID } from "crypto";
import type {
  IpcPushMap,
  UnsavedEntry,
} from "../../shared/contracts/ipc";
import { logLifecycle } from "../utils/lifecycle-log";
import { appLifecycle } from "./index";

/**
 * 询问渲染层的上限：正常应答在毫秒级。
 * 超时按「没有未保存」处理 —— 渲染进程忙/崩时不能把关窗也一起卡死。
 */
const QUERY_TIMEOUT_MS = 1_500;
/** 「保存并退出」的上限：写库 + 可能的相关文件落盘 */
const SAVE_TIMEOUT_MS = 15_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const pendingSaves = new Map<
  string,
  (result: { ok: boolean; error: string | null }) => void
>();

let pendingQuery: {
  requestId: string;
  deferred: Deferred<UnsavedEntry[]>;
  timer: NodeJS.Timeout;
} | null = null;

let pendingConfirm: Promise<boolean> | null = null;

function windowUsable(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(
    window && !window.isDestroyed() && !window.webContents.isDestroyed(),
  );
}

/** 渲染层应答「有没有未保存改动」 */
export function answerUnsavedQuery(
  requestId: string,
  entries: UnsavedEntry[],
): boolean {
  if (!pendingQuery || pendingQuery.requestId !== requestId) return false;
  const { deferred: result, timer } = pendingQuery;
  pendingQuery = null;
  clearTimeout(timer);
  result.resolve(Array.isArray(entries) ? entries : []);
  return true;
}

/** 渲染层回报「保存并退出」的结果 */
export function settleUnsavedSave(
  requestId: string,
  result: { ok: boolean; error: string | null },
): void {
  const settle = pendingSaves.get(requestId);
  if (!settle) return;
  pendingSaves.delete(requestId);
  settle(result);
}

/**
 * 询问渲染层当前的未保存清单。
 *
 * 没有可用窗口、或渲染层在时限内没有应答，一律返回空数组：
 * 关不掉窗口比丢一次未保存确认更糟。
 */
function queryUnsaved(window: BrowserWindow | null): Promise<UnsavedEntry[]> {
  if (!windowUsable(window)) return Promise.resolve([]);
  if (pendingQuery) return pendingQuery.deferred.promise;

  const requestId = randomUUID();
  const result = deferred<UnsavedEntry[]>();

  const timer = setTimeout(() => {
    if (pendingQuery?.requestId !== requestId) return;
    logLifecycle("未保存询问超时：按“无未保存改动”处理");
    pendingQuery = null;
    result.resolve([]);
  }, QUERY_TIMEOUT_MS);

  pendingQuery = { requestId, deferred: result, timer };

  const payload: IpcPushMap["app:unsaved:query"] = { requestId };
  window.webContents.send("app:unsaved:query", payload);

  return result.promise;
}

/** 请求渲染层保存全部未保存改动 */
function requestSaveAll(
  window: BrowserWindow | null,
): Promise<{ ok: boolean; error: string | null }> {
  if (!windowUsable(window)) {
    return Promise.resolve({ ok: false, error: "窗口已关闭，无法保存" });
  }

  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSaves.delete(requestId);
      logLifecycle("保存并退出：渲染层未在时限内应答");
      resolve({ ok: false, error: "保存超时" });
    }, SAVE_TIMEOUT_MS);

    pendingSaves.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    const payload: IpcPushMap["app:unsaved:saveAll"] = { requestId };
    window.webContents.send("app:unsaved:saveAll", payload);
  });
}

function summarize(entries: UnsavedEntry[]): string {
  const labels = entries.map((entry) => entry.label).filter(Boolean);
  if (labels.length === 0) return "还有未保存的修改。";
  const shown = labels.slice(0, 3).join("、");
  return labels.length > 3
    ? `${shown} 等 ${labels.length} 处还有未保存的修改。`
    : `${shown}还有未保存的修改。`;
}

/**
 * 弹一次原生确认；返回 true 表示可以继续关闭/退出。
 *
 * 并发调用共享同一个 Promise：关闭按钮与退出快捷键可能同时触发，
 * 不能弹两个框。
 */
export function confirmUnsaved(
  window: BrowserWindow | null,
): Promise<boolean> {
  if (appLifecycle.isClosing()) return Promise.resolve(true);
  if (pendingConfirm) return pendingConfirm;

  const run = async (): Promise<boolean> => {
    const entries = await queryUnsaved(window);
    if (entries.length === 0) return true;

    const canSave = entries.some((entry) => entry.canSave);
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: canSave
        ? ["取消", "不保存并退出", "保存并退出"]
        : ["取消", "不保存并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "有未保存的更改",
      message: summarize(entries),
      detail: canSave
        ? "保存后继续退出；选择「不保存并退出」会丢失这些修改。"
        : "直接退出会丢失这些修改。",
    };

    const { response } = windowUsable(window)
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    const cancel = 0;
    const discard = 1;
    const save = 2;

    if (response === cancel) {
      logLifecycle("未保存确认：用户取消");
      return false;
    }

    if (response === save && canSave) {
      const result = await requestSaveAll(window);
      if (!result.ok) {
        logLifecycle(`未保存确认：保存失败，取消退出（${result.error ?? "未知错误"}）`);
        const failure: MessageBoxOptions = {
          type: "error",
          title: "保存失败",
          message: "未保存的修改没有写入，已取消退出。",
          detail: result.error ?? "",
        };
        if (windowUsable(window)) {
          await dialog.showMessageBox(window, failure);
        } else {
          await dialog.showMessageBox(failure);
        }
        return false;
      }
      logLifecycle("未保存确认：保存并退出");
      return true;
    }

    if (response === discard) {
      logLifecycle("未保存确认：不保存并退出");
      return true;
    }

    // 对话框被系统关闭等异常应答：按取消处理，不丢数据
    return false;
  };

  const promise = run();
  pendingConfirm = promise;
  return promise.finally(() => {
    if (pendingConfirm === promise) pendingConfirm = null;
  });
}

/**
 * 给窗口装关窗守卫。
 *
 * 只有「未保存确认通过」才真正 close；确认期间先 preventDefault。
 * 退出流程已开始时直接放行，避免清理完成后又被拦一次。
 */
export function installWindowCloseGuard(win: BrowserWindow): void {
  let allowClose = false;

  win.on("close", (event) => {
    if (allowClose || appLifecycle.isClosing()) return;
    if (!windowUsable(win)) return;

    event.preventDefault();
    void confirmUnsaved(win).then((proceed) => {
      if (!proceed || win.isDestroyed()) return;
      allowClose = true;
      win.close();
    });
  });
}

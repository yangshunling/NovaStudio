/**
 * 周报 IPC
 *
 * 生成走一次性文本生成（不建会话），把增量片段按 requestId 推回渲染层，
 * 让弹窗可以在等待期间渐进显示内容。取消按 requestId 定向中断，
 * 不影响其它正在生成的周报。
 */

import { handle } from "../register";
import { push } from "../push";
import { saveTextFile } from "../nativeUi";
import { errorMessage } from "../../../shared/error";
import { generateWeeklyReport } from "../../reports/weekly";

/** requestId → 取消句柄。允许不同周期并发生成，互相之间互不干扰 */
const controllers = new Map<string, AbortController>();

export function registerReportHandlers(): void {
  handle("report:generate", async ({ requestId, start, end, options }) => {
    if (!requestId) return { ok: false, error: "缺少生成任务标识" };
    if (controllers.has(requestId)) {
      return { ok: false, error: "该生成任务已在运行" };
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { ok: false, error: "周报周期无效" };
    }

    const controller = new AbortController();
    controllers.set(requestId, controller);
    try {
      const markdown = await generateWeeklyReport({
        range: { start, end },
        options,
        signal: controller.signal,
        onChunk: (chunk) => push("report:chunk", { requestId, chunk }),
      });
      return { ok: true, markdown };
    } catch (err) {
      return {
        ok: false,
        error: controller.signal.aborted ? "已取消生成" : errorMessage(err),
      };
    } finally {
      controllers.delete(requestId);
    }
  });

  handle("report:abort", ({ requestId }) => {
    const controller = controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  handle("report:export", ({ content, defaultName }) => {
    if (!content.trim()) throw new Error("没有可导出的内容");
    return saveTextFile(content, defaultName);
  });
}

/**
 * 未保存改动协议的主进程入口
 *
 * 渲染层只负责回答「有没有未保存」以及「保存结果」，是否关窗/退出由
 * lifecycle/unsaved 决定。参见该文件的约束说明。
 */

import { handle } from "../register";
import { answerUnsavedQuery, settleUnsavedSave } from "../../lifecycle/unsaved";

export function registerUnsavedHandlers(): void {
  handle("app:unsaved:answer", ({ requestId, entries }) =>
    answerUnsavedQuery(requestId, entries),
  );
  handle("app:unsaved:saveResult", ({ requestId, ok, error }) => {
    settleUnsavedSave(requestId, { ok, error });
    return true;
  });
}

/**
 * 后台活动变化通知
 *
 * 窗口的后台节流要跟随「是否有 Agent / 工作流在跑」。原来每 2 秒轮询
 * hasActiveBackgroundWork()：
 *   - 空闲时也在唤醒主循环；
 *   - 运行开始后最多 2 秒才恢复全速，窗口失焦时流式输出会被 Chromium
 *     节流成整块到达。
 *
 * 这里改成显式通知：运行开始 / 结束的点调用 notifyActivityChanged()，
 * 订阅方（窗口）据此立即调整节流。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅活动变化，返回取消订阅函数 */
export function onActivityChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 运行开始 / 结束时调用；重复调用无副作用（订阅方自行比较状态） */
export function notifyActivityChanged(): void {
  for (const listener of [...listeners]) listener();
}

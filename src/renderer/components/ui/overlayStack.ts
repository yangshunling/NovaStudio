/**
 * 浮层栈 — 保证 Esc 只关闭最顶层
 *
 * Modal / Drawer 都监听 document 的 keydown。若同时打开两层（例如抽屉里弹出
 * 确认框），两层都会收到 Esc，结果一次按键关掉两个浮层。这里用模块级栈记录
 * 打开顺序，只有栈顶的浮层响应 Esc。
 */

const stack: object[] = [];

/** 浮层挂载时入栈（后挂载 = 更靠上） */
export function pushOverlay(token: object): void {
  stack.push(token);
}

/** 浮层卸载时出栈；找不到时静默忽略 */
export function popOverlay(token: object): void {
  const index = stack.lastIndexOf(token);
  if (index >= 0) stack.splice(index, 1);
}

/** 当前浮层是否位于最顶层 */
export function isTopOverlay(token: object): boolean {
  return stack[stack.length - 1] === token;
}

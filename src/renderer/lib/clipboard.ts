/**
 * 剪贴板写入
 *
 * 会话里的「复制」按钮统一走这里，而不是各处直接调用
 * `navigator.clipboard.writeText`：
 *
 * - 沙箱渲染进程在窗口失焦、权限被拒等情况下会让 Clipboard API 直接 reject，
 *   按钮看上去「点了没反应」；
 * - 此时退回 execCommand 的临时选区方案，它只依赖 DOM，基本不会失败。
 *
 * 返回是否写入成功，由调用方决定提示文案。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 继续走兜底
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // readonly 防止移动端键盘弹出；fixed + 透明让选区落在视口内又不闪动
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

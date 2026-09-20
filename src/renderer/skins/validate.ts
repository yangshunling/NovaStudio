/**
 * 皮肤 token 完整性校验（仅开发模式）
 *
 * 逐套皮肤检查契约里的 token 是否都能解析出非空值，缺失立即在控制台报警。
 * 目的是在新增皮肤时当场发现漏定义的 token，而不是等到某个组件
 * 渲染出透明背景 / 失效边框才发现。
 *
 * token 清单来自 skins/contract.ts（唯一真相来源），本文件不另抄一份。
 *
 * 实现：挂一个不可见的探针元素，依次把 data-theme 切到每套皮肤并读计算样式。
 * 因为皮肤的 token 选择器是 [data-theme="<id>"]（不只匹配 <html>），探针即可精确取样，
 * 不会造成界面闪烁。_base.css / 族文件提供的默认值同样能被取到 —— 这正是我们要的：
 * 校验的是最终计算值。
 */

import { REQUIRED_TOKENS } from "./contract";
import { skins } from "./registry";

export function validateSkins(): void {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);

  const failures: string[] = [];
  try {
    for (const skin of skins) {
      probe.setAttribute("data-theme", skin.id);
      const style = getComputedStyle(probe);
      const missing = REQUIRED_TOKENS.filter(
        (token) => style.getPropertyValue(token).trim() === "",
      );
      if (missing.length > 0) failures.push(`${skin.id} → ${missing.join(", ")}`);
    }
  } finally {
    probe.remove();
  }

  if (failures.length > 0) {
    console.warn(`[skin] 以下皮肤缺少必填 token：\n${failures.join("\n")}`);
  }
}

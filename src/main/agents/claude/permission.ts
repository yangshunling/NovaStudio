/**
 * Claude Code 权限模式的名字转换。
 *
 * settings.json 的 `permissions.defaultMode` 用 `default` 表示标准交互模式，
 * 而 CLI 的 `--permission-mode` 用 `manual` 表示同一个模式。其余档位两边同名。
 * 只放行已知档位：自定义 / 未来档位不认识的字符串宁可退回「不传参数」，
 * 避免 CLI 因非法枚举直接拒绝启动。
 */

const CLI_PERMISSION_MODES = new Set([
  "manual",
  "auto",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);

/** settings 名 → CLI 名；无法识别或为空时返回 null（不传 --permission-mode） */
export function toCliPermissionMode(mode: string | null | undefined): string | null {
  const value = mode?.trim();
  if (!value) return null;
  if (value === "default") return "manual";
  return CLI_PERMISSION_MODES.has(value) ? value : null;
}

/**
 * 权限模式：Agent 配置页与会话工具栏共用的一份定义。
 *
 * value 使用 Claude Code 的 settings 命名（`default`），终端参数名由
 * provider 自行映射（CLI 的 `--permission-mode` 对应 `manual`）。
 * description 会同时显示在下拉菜单与会话工具栏的提示里，保持单行可读。
 */

export interface PermissionModeOption {
  value: string;
  label: string;
  description: string;
}

/**
 * 未显式配置时的默认权限。
 *
 * 聊天会话在 default / auto / acceptEdits 下会弹窗询问；但工作流与自动化
 * 是无人值守运行（固定 bypass），默认保持放开可避免开箱即用时工具被静默拒绝。
 */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/**
 * 无人值守运行（工作流 / 自动化）固定使用的权限模式。
 *
 * 这些运行没有界面回答询问；显式指定 bypass 是为了避免跟随 Agent 默认值
 * 调低后，工具被静默拒绝、任务表面成功但产物残缺。
 */
export const HEADLESS_PERMISSION_MODE = "bypassPermissions";

/**
 * 该模式是否可能向用户发起工具授权询问。
 *
 * - default / auto / acceptEdits：需要人工回答（auto 在高风险时仍会问）
 * - plan：只读规划，不执行写操作
 * - dontAsk：直接拒绝，不询问
 * - bypassPermissions：全部放行
 * - 未知值：不假设，保持原行为（不传交互参数）
 */
export function modeMayAsk(mode: string | null | undefined): boolean {
  return (
    mode === "default" ||
    mode === "auto" ||
    mode === "acceptEdits" ||
    // CLI 的 settings 命名差异：manual 与 default 等价
    mode === "manual"
  );
}

export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  {
    value: "default",
    label: "default",
    description: "只读自动放行，写操作先询问",
  },
  {
    value: "auto",
    label: "auto",
    description: "自动判断风险，高风险仍询问",
  },
  {
    value: "acceptEdits",
    label: "acceptEdits",
    description: "自动接受文件编辑，其余仍询问",
  },
  {
    value: "plan",
    label: "plan",
    description: "只读规划，不修改文件",
  },
  {
    value: "dontAsk",
    label: "dontAsk",
    description: "不弹询问，未授权直接拒绝",
  },
  {
    value: "bypassPermissions",
    label: "bypassPermissions",
    description: "跳过全部检查，仅受信环境使用",
  },
];

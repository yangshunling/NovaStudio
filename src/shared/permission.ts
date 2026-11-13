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
 * Nova 的会话与工作流都是无人工应答的运行（不接 permission prompt），
 * 用 default / dontAsk 会让需要授权的工具被直接拒绝，因此默认放开。
 */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";

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

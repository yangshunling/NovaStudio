/**
 * 标准对话框
 *
 * 组合了 90% 弹窗的固定结构：标题栏 + 内容区 + 底部操作区。
 * 业务只描述「标题、说明、内容、动作」，不再重复 p-section / ModalHeader /
 * 分隔线 / 按钮排布。需要自定义布局（左菜单 + 右内容）时直接用底层 <Modal>。
 *
 *   <Dialog open={open} onClose={close} title="重命名工作区">
 *     <Field label="名称"><TextInput value={name} onChange={...} /></Field>
 *     <DialogActions>
 *       <Button onClick={close}>取消</Button>
 *       <Button variant="primary" loading={saving}>保存</Button>
 *     </DialogActions>
 *   </Dialog>
 */

import type { CSSProperties, ReactNode } from "react";
import { Modal, ModalHeader } from "./Modal";

/** 对话框宽度档位：sm=表单确认 / md=普通表单 / lg=复杂表单 / xl=全屏内容 */
export type DialogWidth = "sm" | "md" | "lg" | "xl";

const DIALOG_WIDTHS: Record<DialogWidth, string> = {
  sm: "w-[440px] max-w-[90vw]",
  md: "w-[520px] max-w-[92vw]",
  lg: "w-[640px] max-w-[92vw]",
  xl: "w-[900px] max-w-[94vw]",
};

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 宽度档位；优先于 widthClass */
  width?: DialogWidth;
  /** 自定义容器宽度（Tailwind 类名），覆盖 width */
  widthClass?: string;
  /** 容器自定义样式（可选） */
  size?: CSSProperties;
  /** 标题下方的说明文字 */
  description?: ReactNode;
  /** 标题栏额外类名（例如更紧凑的 mb-2） */
  headerClassName?: string;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  width = "md",
  widthClass,
  size,
  description,
  headerClassName,
  children,
}: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClass={widthClass ?? DIALOG_WIDTHS[width]}
      size={size}
    >
      <div className="p-section">
        <ModalHeader
          title={title}
          onClose={onClose}
          className={headerClassName ?? "mb-4"}
        />
        {description && (
          <p className="mb-4 text-body leading-relaxed text-text-muted">
            {description}
          </p>
        )}
        {children}
      </div>
    </Modal>
  );
}

interface DialogActionsProps {
  children: ReactNode;
  /** 左侧需要辅助操作时传 "justify-between" */
  className?: string;
}

/** 对话框页脚：顶部分隔线 + 右对齐操作按钮 */
export function DialogActions({
  children,
  className = "",
}: DialogActionsProps) {
  return (
    <div
      className={`mt-5 flex items-center justify-end gap-2 border-t border-border pt-3 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

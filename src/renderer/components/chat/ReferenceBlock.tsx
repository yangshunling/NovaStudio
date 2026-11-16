/**
 * 用户消息里的块状引用
 *
 * 发送时引用说明只进入 prompt，界面展示则是这个块：图标 + 名称。
 * 文件 / 会话的路径只留在数据里（重试与定位用），不展示在消息中。
 * 用一层纸面与发丝线压在气泡上，昼夜皮肤下都能读出这是可展开的引用。
 */

import { FileText, Library, MessagesSquare, Sparkles, Wrench } from "lucide-react";
import type { ReferenceKind } from "@shared/types";

const ICONS: Record<ReferenceKind, typeof FileText> = {
  file: FileText,
  session: MessagesSquare,
  tool: Wrench,
  skill: Sparkles,
  knowledge: Library,
};

export function ReferenceBlock({
  kind,
  name,
}: {
  kind: ReferenceKind;
  name: string;
  /**
   * 路径 / 说明只保留在数据里（重试时重建 prompt 用），
   * 不渲染到消息中。
   */
  detail?: string;
}) {
  const Icon = ICONS[kind] ?? FileText;

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-left last:mb-0">
      <span className="grid h-5 w-5 shrink-0 place-items-center text-text-muted">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate ui-type-sub text-text-secondary">
        {name}
      </span>
    </div>
  );
}

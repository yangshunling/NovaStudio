/**
 * 用户消息里的块状引用
 *
 * 发送时引用说明只进入 prompt，界面展示则是这个块：图标 + 名称。
 * 文件 / 会话的路径只留在数据里（重试与定位用），不展示在消息中。
 * 样式刻意压在用户气泡的靛蓝底上（白色半透明），昼夜皮肤下都能与气泡融为一体。
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
    <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-2.5 py-2 text-left last:mb-0">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/15 text-bubble-user-text">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate ui-type-label text-bubble-user-text">
        {name}
      </span>
    </div>
  );
}

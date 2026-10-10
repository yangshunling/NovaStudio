/**
 * 渲染本地提取的 vscode-icons SVG。
 *
 * 所有图标统一放进固定正方形盒子，并保留各自原始配色。
 */

import type { VscodeIconData } from "./vscodeFileIcons";

export function VscodeIcon({
  icon,
  size = 16,
  className = "",
}: {
  icon: VscodeIconData;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${icon.width} ${icon.height}`}
        preserveAspectRatio="xMidYMid meet"
        dangerouslySetInnerHTML={{ __html: icon.body }}
      />
    </span>
  );
}

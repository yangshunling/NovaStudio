/**
 * 昼夜切换按钮
 *
 * 从注册表里找一套明暗属性与当前皮肤相反的皮肤；找不到时顺序切到下一套。
 * 因此宿主不写死任何皮肤 id，新增皮肤也无需改动本组件。
 */

import { Moon, Sun } from "lucide-react";
import { useSkin, useTheme } from "../hooks/useTheme";

export function ThemeToggle() {
  const { currentTheme, setTheme, skins } = useTheme();
  const current = useSkin();

  const index = skins.findIndex((skin) => skin.id === currentTheme);
  const target =
    skins.find((skin) => skin.appearance !== current.appearance) ??
    skins[(index + 1) % skins.length];

  const isDark = current.appearance === "dark";
  const label = isDark ? "切换到日间模式" : "切换到夜间模式";

  return (
    <button
      type="button"
      onClick={() => target && setTheme(target.id)}
      disabled={skins.length < 2}
      title={label}
      aria-label={label}
      className="ui-btn-round ui-icon-action flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:cursor-default disabled:opacity-40"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

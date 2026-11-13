/**
 * 外观设置：主题、字体与界面字号
 */

import { Check } from "lucide-react";
import { useTheme } from "../../hooks/useTheme";
import {
  FONT_PRESETS,
  fontPresetPreview,
} from "../../skins/typography";
import {
  OptionButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
} from "./SettingsLayout";

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;

function ThemeCard() {
  const { currentTheme, setTheme, skins } = useTheme();

  return (
    <SettingsCard
      title="主题"
      description="昼间适合明亮环境，夜间降低整体亮度；修改后立即应用到所有窗口。"
    >
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          {skins.map((skin) => {
            const active = skin.id === currentTheme;
            return (
              <button
                key={skin.id}
                type="button"
                onClick={() => setTheme(skin.id)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? "border-accent bg-accent-soft"
                    : "border-border hover:border-border-strong hover:bg-surface-hover"
                }`}
              >
                {/* 预览直接用皮肤自己的 token：data-theme 让变量在子树内生效 */}
                <span
                  data-theme={skin.id}
                  className="flex h-20 items-stretch gap-1.5 overflow-hidden rounded-lg border p-2"
                  style={{
                    background: "var(--c-bg)",
                    borderColor: "var(--c-border)",
                  }}
                >
                  <span
                    className="flex w-8 shrink-0 flex-col gap-1 rounded-md p-1"
                    style={{ background: "var(--c-surface-2)" }}
                  >
                    <span
                      className="h-1 w-full rounded-full"
                      style={{ background: "var(--c-text-muted)" }}
                    />
                    <span
                      className="h-1 w-3/4 rounded-full"
                      style={{ background: "var(--c-text-muted)" }}
                    />
                  </span>
                  <span
                    className="flex min-w-0 flex-1 flex-col justify-between rounded-md p-1.5"
                    style={{ background: "var(--c-surface)" }}
                  >
                    <span
                      className="h-1.5 w-12 rounded-full"
                      style={{ background: "var(--c-accent)" }}
                    />
                    <span
                      className="h-1.5 w-8 rounded-full"
                      style={{ background: "var(--c-text-secondary)" }}
                    />
                  </span>
                </span>

                <span className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="ui-type-body font-medium text-text">
                    {skin.displayName}
                  </span>
                  {active && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                  )}
                </span>
                <span className="mt-0.5 block ui-type-note text-text-muted">
                  {skin.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </SettingsCard>
  );
}

function FontCard() {
  const { fontFamily, setFontFamily } = useTheme();
  // 已移除的预设（如老版本保存的「苹方」）按系统默认显示，避免没有任何选中项
  const activeId = FONT_PRESETS.some((option) => option.id === fontFamily)
    ? fontFamily
    : "system";

  return (
    <SettingsCard
      title="字体"
      description="使用系统已安装的字体，缺失时自动回退；代码、路径与终端仍使用系统等宽字体。"
    >
      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
        {FONT_PRESETS.map((option) => {
          const active = option.id === activeId;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setFontFamily(option.id)}
              aria-pressed={active}
              className={`rounded-lg border p-2.5 text-left transition-colors ${
                active
                  ? "border-accent bg-accent-soft"
                  : "border-border hover:border-border-strong hover:bg-surface-hover"
              }`}
            >
              {/* 预览直接用该字体的字体栈，选之前就能看出字形差异 */}
              <span
                className="block truncate ui-type-body text-text"
                style={{ fontFamily: fontPresetPreview(option.id) }}
              >
                Aa 汉字 123
              </span>
              <span className="mt-1.5 flex items-center justify-between gap-2">
                <span
                  className={`ui-type-note ${
                    active ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {option.label}
                </span>
                {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsCard>
  );
}

function FontSizeCard() {
  const { fontSize, chatFontSize, setFontSize, setChatFontSize } = useTheme();

  return (
    <SettingsCard
      title="文字大小"
      description="全局字号是整套界面的缩放基准，文件预览与工作区文件跟随全局字号。"
    >
      <SettingsRow label="全局" hint="界面整体缩放基准">
        <div className="flex flex-wrap justify-end gap-1.5">
          {FONT_SIZE_OPTIONS.map((size) => (
            <OptionButton
              key={size}
              active={fontSize === size}
              onClick={() => setFontSize(size)}
            >
              {size}px
            </OptionButton>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow label="聊天记录" hint="只影响聊天记录区域">
        <div className="flex flex-wrap justify-end gap-1.5">
          {FONT_SIZE_OPTIONS.map((size) => (
            <OptionButton
              key={size}
              active={chatFontSize === size}
              onClick={() => setChatFontSize(size)}
            >
              {size}px
            </OptionButton>
          ))}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}

export function AppearancePanel() {
  return (
    <SettingsPage title="外观" description="主题、字体与界面字号。">
      <ThemeCard />
      <FontCard />
      <FontSizeCard />
    </SettingsPage>
  );
}

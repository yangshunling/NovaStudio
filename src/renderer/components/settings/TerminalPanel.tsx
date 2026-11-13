/**
 * 终端设置
 *
 * 终端字号独立于界面字号：终端里常需要更大字号，且字体固定为系统等宽字体。
 */

import { useTheme } from "../../hooks/useTheme";
import {
  OptionButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
} from "./SettingsLayout";

/** 终端字号刻度比界面略宽：11–20px */
const TERMINAL_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 18, 20] as const;

export function TerminalPanel() {
  const { terminalFontSize, setTerminalFontSize } = useTheme();

  return (
    <SettingsPage title="终端" description="终端窗口的显示设置。">
      <SettingsCard
        title="显示"
        description="字号独立于界面字号，修改后立即生效；字体固定使用系统等宽字体。"
      >
        <SettingsRow label="字号">
          <div className="flex flex-wrap justify-end gap-1.5">
            {TERMINAL_FONT_SIZE_OPTIONS.map((size) => (
              <OptionButton
                key={size}
                active={terminalFontSize === size}
                onClick={() => setTerminalFontSize(size)}
              >
                {size}px
              </OptionButton>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
}

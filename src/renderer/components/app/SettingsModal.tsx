/**
 * 设置弹框 — 基于通用 Modal 的模态框
 *
 * 只负责左侧导航与面板切换；各分组的内容拆在 components/settings/ 下，
 * 新增分组时在这里加一行菜单即可。
 */

import { useEffect, useState } from "react";
import {
  Info,
  Palette,
  SlidersHorizontal,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { Modal, ModalHeader } from "../ui/Modal";
import { useChatStore } from "../../stores/chat";
import { hasUpdateNotice, useUpdaterStore } from "../../stores/updater";
import { loadAppSettings } from "../../hooks/useAppSettings";
import { GeneralPanel } from "../settings/GeneralPanel";
import { AppearancePanel } from "../settings/AppearancePanel";
import { TerminalPanel } from "../settings/TerminalPanel";
import { AutomationPanel } from "../settings/AutomationPanel";
import { AboutPanel } from "../settings/AboutPanel";

type SettingsSection =
  | "general"
  | "appearance"
  | "terminal"
  | "automation"
  | "about";

/** 左侧菜单项：新增设置分组只需在这里加一行 */
const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  Icon: typeof SlidersHorizontal;
}> = [
  { id: "general", label: "通用", Icon: SlidersHorizontal },
  { id: "appearance", label: "外观", Icon: Palette },
  { id: "terminal", label: "终端", Icon: SquareTerminal },
  { id: "automation", label: "自动化", Icon: Workflow },
  { id: "about", label: "关于与更新", Icon: Info },
];

export function SettingsModal() {
  const setShowSettings = useChatStore((s) => s.setShowSettings);
  const updateNotice = useUpdaterStore((s) => hasUpdateNotice(s.state));
  const [section, setSection] = useState<SettingsSection>("general");

  // 运行设置是共享状态：打开设置页时读一次，之后各面板共用
  useEffect(() => {
    void loadAppSettings();
  }, []);

  return (
    // 由 App.tsx 的 showSettings 条件渲染控制挂载，因此此处 open 恒为 true
    <Modal
      open={true}
      onClose={() => setShowSettings(false)}
      size={{
        width: "var(--c-layout-modal-w)",
        height: "var(--c-layout-modal-h)",
        maxWidth: "1200px",
        maxHeight: "800px",
      }}
    >
      {/* 弹框头 */}
      <ModalHeader
        title="设置"
        onClose={() => setShowSettings(false)}
        className="h-[var(--c-layout-header)] shrink-0 border-b border-border px-section"
      />

      {/* 弹框正文：左侧菜单 + 右侧内容 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧菜单 */}
        <aside className="flex w-[var(--c-layout-menu)] shrink-0 flex-col gap-1 border-r border-border bg-surface-2/40 p-2.5">
          <p className="px-2 pb-1.5 pt-1 ui-type-sub font-semibold text-text-muted">
            设置
          </p>
          {SETTINGS_SECTIONS.map(({ id, label, Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 ui-type-body font-medium transition-colors ${
                  active
                    ? "bg-selected text-accent"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "bg-surface-hover text-text-muted"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {label}
                {id === "about" && updateNotice && (
                  <span
                    role="img"
                    aria-label="有可用更新"
                    title="有可用更新"
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-error"
                  />
                )}
              </button>
            );
          })}
        </aside>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto p-section">
          {section === "general" && <GeneralPanel />}
          {section === "appearance" && <AppearancePanel />}
          {section === "terminal" && <TerminalPanel />}
          {section === "automation" && <AutomationPanel />}
          {section === "about" && <AboutPanel />}
        </div>
      </div>
    </Modal>
  );
}

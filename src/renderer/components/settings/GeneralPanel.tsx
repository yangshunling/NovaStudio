/**
 * 通用设置：新建会话的默认值
 *
 * 只放「没有更合适归属」的全局默认项；视觉与自动化各有独立分组。
 */

import { useChatStore } from "../../stores/chat";
import { useAppSettingsStore } from "../../hooks/useAppSettings";
import { ipc } from "../../lib/ipc";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { SettingsCard, SettingsPage, SettingsRow } from "./SettingsLayout";

function DefaultAgentRow() {
  const agents = useChatStore((s) => s.agents);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const selectAgent = useChatStore((s) => s.selectAgent);

  const installed = agents.filter((agent) => agent.status.installed);

  return (
    <SettingsRow
      label="默认 Agent"
      hint="新建会话默认使用；已开会话可在输入框旁单独切换。"
    >
      <Select
        value={selectedAgentId}
        onChange={selectAgent}
        disabled={installed.length === 0}
        placeholder={installed.length === 0 ? "未检测到已安装的 Agent" : "请选择"}
        className="ui-ring w-40 rounded-lg bg-input-bg px-inset py-inset ui-type-note text-text"
        minMenuWidth={180}
        options={installed.map((agent) => ({
          value: agent.id,
          label: agent.displayName,
        }))}
      />
    </SettingsRow>
  );
}

function DefaultCwdRow() {
  const defaultCwd = useAppSettingsStore((s) => s.defaultCwd);
  const update = useAppSettingsStore((s) => s.update);

  const handlePick = async () => {
    const picked = await ipc.pickDirectory();
    if (picked) await update({ defaultCwd: picked });
  };

  return (
    <SettingsRow
      label="默认工作目录"
      hint="未设置时使用用户主目录；新会话与自动化任务都在此目录启动。"
    >
      <span
        className="max-w-[260px] truncate ui-type-note text-text-secondary"
        title={defaultCwd || "用户主目录"}
      >
        {defaultCwd || "用户主目录"}
      </span>
      <Button size="sm" variant="ghost" onClick={() => void handlePick()}>
        选择
      </Button>
      {defaultCwd && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void update({ defaultCwd: "" })}
        >
          清除
        </Button>
      )}
    </SettingsRow>
  );
}

export function GeneralPanel() {
  return (
    <SettingsPage
      title="通用"
      description="新建会话与任务使用的默认值，修改后立即生效。"
    >
      <SettingsCard>
        <DefaultAgentRow />
        <DefaultCwdRow />
      </SettingsCard>
    </SettingsPage>
  );
}

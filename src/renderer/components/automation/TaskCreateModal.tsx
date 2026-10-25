/**
 * 任务创建弹框 — 录入自然语言任务，绑定项目 + Agent 后下发
 *
 * 默认选中第一个已安装的 Agent；Ctrl/Cmd + Enter 快捷提交
 */

import { useEffect, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Modal, ModalHeader } from "../ui/Modal";
import { Select } from "../ui/Select";
import { useAutomationStore } from "../../stores/automation";
import { useChatStore } from "../../stores/chat";

export function TaskCreateModal({ onClose }: { onClose: () => void }) {
  const projects = useChatStore((s) => s.projects);
  const agents = useChatStore((s) => s.agents);
  const createTask = useAutomationStore((s) => s.createTask);

  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 默认选第一个已安装的 Agent
  useEffect(() => {
    if (agentId) return;
    const firstInstalled = agents.find((a) => a.status.installed);
    if (firstInstalled) setAgentId(firstInstalled.id);
  }, [agents, agentId]);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId || !agentId) return;
    setSubmitting(true);
    try {
      await createTask(trimmed, projectId, agentId);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} widthClass="w-[480px] max-w-[90vw]">
      <div className="p-section">
        {/* 标题 */}
        <ModalHeader title="新建自动化任务" onClose={onClose} />

        {/* Prompt 输入 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-meta font-medium text-text-muted">任务描述</label>
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
            placeholder="用自然语言描述你想让 Agent 做什么…"
            rows={4}
            className="ui-ring w-full resize-none rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text placeholder-text-muted outline-none focus:border-input-border-focus"
          />
        </div>

        {/* 项目选择 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-meta font-medium text-text-muted">绑定项目</label>
          <Select
            value={projectId}
            onChange={setProjectId}
            placeholder={projects.length === 0 ? "无可用项目" : "选择项目"}
            className="ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text"
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
            }))}
          />
        </div>

        {/* Agent 选择 */}
        <div className="mb-5">
          <label className="mb-1.5 block text-meta font-medium text-text-muted">绑定 Agent</label>
          <Select
            value={agentId}
            onChange={setAgentId}
            placeholder={agents.length === 0 ? "检测中…" : "选择 Agent"}
            className="ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text"
            options={agents.map((agent) => ({
              value: agent.id,
              label: `${agent.displayName}${
                agent.status.version ? ` v${agent.status.version}` : ""
              }${agent.status.installed ? "" : "（未安装）"}`,
              disabled: !agent.status.installed,
            }))}
          />
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="ui-btn-ghost rounded-full px-4 py-2 text-body"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || !projectId || !agentId || submitting}
            className="ui-btn-primary flex items-center gap-1.5 rounded-full px-4 py-2 text-body"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            下发任务
          </button>
        </div>
      </div>
    </Modal>
  );
}

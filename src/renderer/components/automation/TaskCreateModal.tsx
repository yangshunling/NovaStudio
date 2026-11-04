/**
 * 任务创建弹框 — 录入自然语言任务，绑定项目后下发
 *
 * 当前仅支持 Claude，Agent 固定为 claude，无需用户选择；
 * Ctrl/Cmd + Enter 快捷提交
 */

import { useState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextArea, FORM_INPUT_CLASS } from "../ui/Field";
import { Select } from "../ui/Select";
import { useAutomationStore } from "../../stores/automation";
import { useChatStore } from "../../stores/chat";

/** 自动化任务当前固定使用的 Agent（仅支持 Claude） */
const AGENT_ID = "claude";

export function TaskCreateModal({ onClose }: { onClose: () => void }) {
  const projects = useChatStore((s) => s.projects);
  const createTask = useAutomationStore((s) => s.createTask);

  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    setSubmitting(true);
    try {
      await createTask(trimmed, projectId, AGENT_ID);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="新建自动化任务"
      width="md"
    >
      <div className="space-y-3">
        <Field label="任务描述">
          <TextArea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
            placeholder="用自然语言描述你想让 Agent 做什么…"
            rows={4}
            className="resize-none"
          />
        </Field>

        <Field label="指定工作区">
          <Select
            value={projectId}
            onChange={setProjectId}
            placeholder={projects.length === 0 ? "无可用工作区" : "选择工作区"}
            className={FORM_INPUT_CLASS}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
            }))}
          />
        </Field>
      </div>

      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!prompt.trim() || !projectId}
          loading={submitting}
          icon={<Plus className="h-4 w-4" />}
        >
          下发任务
        </Button>
      </DialogActions>
    </Dialog>
  );
}

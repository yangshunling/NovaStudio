/**
 * 任务创建弹框 — 录入自然语言任务，绑定项目与执行人后下发
 *
 * 当前仅支持 Claude，Agent 固定为 claude，无需用户选择；
 * 执行人可选数字员工，默认「通用助手」（不绑定员工，走 Agent 全局配置）。
 * Ctrl/Cmd + Enter 快捷提交
 */

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextArea, FORM_INPUT_CLASS } from "../ui/Field";
import { Select } from "../ui/Select";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";
import claudeAvatarUrl from "../../assets/claude.png";
import { useAutomationStore } from "../../stores/automation";
import { useChatStore } from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import { DEFAULT_ASSISTANT } from "../../lib/employee-switch";
import { confirmDialog } from "../../stores/confirm";
import { toast } from "../../stores/toast";
import { toMessage } from "../../lib/utils";

/** 自动化任务当前固定使用的 Agent（仅支持 Claude） */
const AGENT_ID = "claude";

export function TaskCreateModal({ onClose }: { onClose: () => void }) {
  const projects = useChatStore((s) => s.projects);
  const createTask = useAutomationStore((s) => s.createTask);

  const employees = useEmployeesStore((s) => s.employees);
  const loadEmployees = useEmployeesStore((s) => s.load);

  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  /** 执行人：空字符串表示通用助手（不绑定数字员工） */
  const [employeeId, setEmployeeId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  /** 只展示已启用的员工：停用员工运行时不可用 */
  const employeeOptions = [
    {
      value: "",
      label: DEFAULT_ASSISTANT.name,
      description: DEFAULT_ASSISTANT.detail,
      icon: (
        <img
          src={claudeAvatarUrl}
          alt=""
          width={20}
          height={20}
          draggable={false}
          className="rounded-full object-cover"
        />
      ),
    },
    ...employees
      .filter((employee) => employee.enabled)
      .map((employee) => ({
        value: employee.id,
        label: employee.name,
        description: employee.role || "数字员工",
        icon: <EmployeeAvatar employee={employee} size={20} />,
      })),
  ];

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId || submitting) return;
    setSubmitting(true);
    try {
      await createTask(trimmed, projectId, AGENT_ID, employeeId || null);
      onClose();
    } catch (err) {
      // 创建失败时弹框保持打开，正文不丢；明确提示，避免用户以为按钮没反应
      toast.error(toMessage(err), 5000);
    } finally {
      setSubmitting(false);
    }
  };

  const requestClose = async () => {
    if (!prompt.trim()) {
      onClose();
      return;
    }
    const confirmed = await confirmDialog({
      title: "放弃未下发的任务？",
      message: "任务描述尚未提交，关闭后将丢失。",
      confirmLabel: "放弃",
      tone: "danger",
    });
    if (confirmed) onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      requestClose={requestClose}
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
            minMenuWidth={420}
            title={projects.find((project) => project.id === projectId)?.cwd}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
              // 名称与路径同行展示；过长的路径由菜单项统一截断
              description: project.cwd,
            }))}
          />
        </Field>

        <Field label="执行人">
          <Select
            value={employeeId}
            onChange={setEmployeeId}
            className={FORM_INPUT_CLASS}
            options={employeeOptions}
            minMenuWidth={240}
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

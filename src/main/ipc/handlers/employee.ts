/**
 * 数字员工相关 IPC：列表 / 新建 / 更新 / 删除
 *
 * 数字员工本质是一份可复用的「人设 + 能力」档案：头像、系统提示词、
 * MCP 与技能等元数据。执行平台不落在员工上，而由引用它的工作流节点指定。
 * 本层只做 CRUD，具体如何把这些配置注入运行时，由后续流程消费。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";
import { removeEmployeeRuntime } from "../../employees/runtime";
import { EMPLOYEE_SESSION_IN_USE } from "../../../shared/contracts/ipc";
import type { DigitalEmployeeDraft } from "../../../shared/types";
import type { AgentService } from "../../agents/agent-service";
import type { WorkflowRunner } from "../../workflow/runner";

/** 主进程侧的最低校验：UI 之外也可能直接调用 IPC */
function normalizeDraft(draft: DigitalEmployeeDraft): DigitalEmployeeDraft {
  const name = draft.name.trim();
  if (!name) throw new Error("数字员工名称不能为空");
  if (name.length > 60) throw new Error("数字员工名称不能超过 60 个字符");
  return { ...draft, name };
}

/** 找出引用了该员工的工作流；被引用的员工不能直接删除 */
function findWorkflowsUsingEmployee(employeeId: string): string[] {
  return db
    .listWorkflows()
    .filter((workflow) =>
      workflow.graph.nodes.some(
        (node) => node.config.employeeId === employeeId,
      ),
    )
    .map((workflow) => workflow.name);
}

export function registerEmployeeHandlers(
  service: AgentService,
  runner: WorkflowRunner,
): void {
  handle("employees:list", () => db.listDigitalEmployees());

  /*
   * 保存只落库，不碰磁盘。
   *
   * 员工目录是派生物：下一次聊天 / 工作流运行前，主进程会按数据库里的
   * 最新定义重新物化（见 sessions/runtime 与 agents/claude/prepare）。
   * 这样反复编辑不会在磁盘上留下半成品，也不会和正在运行的进程抢文件。
   */
  handle("employees:create", ({ draft }) =>
    db.createDigitalEmployee(normalizeDraft(draft)),
  );

  handle("employees:update", ({ id, draft }) =>
    db.updateDigitalEmployee(id, normalizeDraft(draft)),
  );

  handle("employees:delete", async ({ id, force }) => {
    const employee = db.getDigitalEmployee(id);
    if (!employee) return true;

    /*
     * 员工资产（~/.novastudio/employee/<id>）与运行时（~/.novastudio/runtime/<id>）
     * 由聊天与工作流共享。删除会直接抽掉正在执行节点的 CLAUDE_CONFIG_DIR，
     * 必须先拦住。用运行启动时的图快照判断，运行期间改节点也绕不过去。
     */
    if (runner.hasActiveRunUsingEmployee(id)) {
      throw new Error(
        "无法删除：该数字员工正在被工作流运行使用，请先终止运行",
      );
    }

    /*
     * 聊天运行中也不能删：运行时目录里是它正在使用的配置与认证副本。
     * 不能按会话当前绑定判断 —— 运行中允许把回答者切给别人，绑定的员工
     * 已经不是本轮实际在用的那个；这里按运行快照（run 启动时的员工）判断。
     */
    if (service.isEmployeeInUse(id)) {
      throw new Error("无法删除：该数字员工正在被会话使用，请先停止运行");
    }

    // 删除前必须确认没有工作流仍在使用：否则这些节点会在下次运行时
    // 直接报「员工不存在」，属于不可感知的静默故障。工作流引用不允许强制删除。
    const workflows = findWorkflowsUsingEmployee(id);
    if (workflows.length > 0) {
      const shown = workflows.slice(0, 3).join("、");
      const rest = workflows.length > 3 ? ` 等 ${workflows.length} 个` : "";
      throw new Error(
        `无法删除：工作流「${shown}」${rest}正在使用该员工，请先在节点中解除绑定`,
      );
    }

    /*
     * 聊天会话也持有员工绑定。不直接拒绝删除（用户可能确实不再需要），
     * 但必须在第一次尝试时明确告知影响；确认后带 force 重试。
     */
    const sessions = db.listSessionsByEmployee(id);
    if (sessions.length > 0 && !force) {
      const shown = sessions
        .slice(0, 3)
        .map((session) => `「${session.title}」`)
        .join("、");
      const rest = sessions.length > 3 ? " 等" : "";
      throw new Error(
        `${EMPLOYEE_SESSION_IN_USE}：${shown}${rest} ${sessions.length} 个会话正在使用该员工。` +
          "删除后这些会话会解除绑定并退回普通模式（本地历史保留），确认删除请重试。",
      );
    }

    // 强制删除后，会话退回普通模式：只清员工绑定，保留会话自己的 CLI 上下文
    if (sessions.length > 0) db.clearEmployeeBindings(id);
    db.deleteDigitalEmployee(id);
    await removeEmployeeRuntime(id);
    return true;
  });
}

/**
 * 会话相关 IPC：创建 / 列表 / 详情 / 重命名 / 删除 / 绑定项目
 */

import { randomUUID } from "node:crypto";
import { homedir } from "os";
import type { Message } from "../../../shared/types";
import type { AgentService } from "../../agents/agent-service";
import { getProvider } from "../../agents/registry";
import * as db from "../../db/sqlite";
import {
  ensureSessionBaseRuntime,
  ensureSessionEmployeeRuntime,
  removeSessionRuntime,
} from "../../sessions/runtime";
import { handle } from "../register";

export function registerSessionHandlers(service: AgentService): void {
  /**
   * 预创建空会话。渲染进程在首条消息前调用，拿到 sessionId 后再 agent:send，
   * 这样流式事件从一开始就能按会话路由（多会话并发的关键）。
   *
   * projectId 可为 null：会话不强制绑定项目，未绑定时在默认目录运行。
   */
  handle("session:create", async ({ projectId, agentId, employeeId }) => {
    if (!getProvider(agentId)) {
      throw new Error(`未知 Agent：${agentId}`);
    }
    const project = projectId ? db.getProject(projectId) : null;
    if (projectId && !project) throw new Error("项目不存在");

    /*
     * 员工只是会话当前的回答者；会话创建时仍记录初始选择，
     * 之后可以通过 session:setEmployee 随时切换。
     */
    let boundEmployeeId: string | null = null;
    if (employeeId) {
      const employee = db.getDigitalEmployee(employeeId);
      if (!employee) throw new Error("数字员工不存在");
      if (!employee.enabled) {
        throw new Error(`数字员工「${employee.name}」已停用，无法开始会话`);
      }
      boundEmployeeId = employee.id;
    }

    const cwd = service.resolveCwd(
      project?.cwd,
      db.getSetting("defaultCwd"),
      homedir(),
    );
    const session = db.createSession(
      agentId,
      project?.id ?? null,
      cwd,
      "新会话",
      null,
      "chat",
      boundEmployeeId,
    );

    /*
     * 会话一创建就把 base 环境准备好：
     * - 首轮不 @ 员工时可以直接使用；
     * - 之后 @ 员工只是切到另一个 home，projects 始终共享。
     * 准备失败不阻断建会话，首次发送时会重试。
     */
    try {
      const baseHome = await ensureSessionBaseRuntime(session);
      if (baseHome) db.setSessionConfigDir(session.id, baseHome);
      return db.getSession(session.id) ?? session;
    } catch (err) {
      console.warn("[session] 创建会话运行时失败，将在首次发送时重试：", err);
      return session;
    }
  });

  handle("session:list", () => db.listSessions());

  /**
   * 未绑定工作区时真正使用的目录。
   * 与 session:create 的回退链保持一致：设置里的 defaultCwd → 用户主目录。
   */
  handle("session:defaultCwd", () =>
    service.resolveCwd(db.getSetting("defaultCwd"), homedir()),
  );

  /** 详情：元数据 + provider 回放的历史；带 limit 时走分页 */
  handle("session:get", ({ id, limit, before, beforeId }) =>
    limit
      ? service.getSessionPage(id, {
          limit,
          beforeTimestamp: before,
          beforeMessageId: beforeId,
        })
      : service.getSessionWithHistory(id),
  );

  handle("session:rename", ({ id, title }) => {
    const next = title.trim();
    if (!next) throw new Error("会话标题不能为空");
    if (next.length > 120) throw new Error("会话标题不能超过 120 个字符");
    db.setSessionTitle(id, next);
    return true;
  });

  /** 置顶是浏览偏好，只改 pinned_at，不触碰 updated_at 与 Agent 上下文 */
  handle("session:setPinned", ({ id, pinned }) => {
    if (!db.getSession(id)) return false;
    db.setSessionPinned(id, pinned);
    return true;
  });

  handle("session:delete", async ({ id }) => {
    // 先中断、等待运行收尾并清理 CLI 侧数据，再删索引行。
    // 顺序不能反：运行收尾还会写 messages，提前删会话会触发外键错误。
    await service.releaseSession(id);
    db.deleteSession(id);
    await removeSessionRuntime(id);
    return true;
  });

  /**
   * 切换会话当前使用的数字员工；null 表示不使用员工。
   *
   * 语义是「下一条消息由谁回答」：运行中也可以切，只落库、不物化。
   * 本轮进程在启动时已固定配置目录 / 系统提示词 / MCP / 技能，
   * 改绑定影响不到它；下一轮 agent:send 的 prepareSessionChatRun 会按新员工
   * 重新准备运行时。
   */
  handle("session:setEmployee", async ({ sessionId, employeeId }) => {
    const session = db.getSession(sessionId);
    if (!session) return null;
    if (session.source === "workflow") {
      throw new Error("工作流会话不能切换数字员工");
    }

    let employee: ReturnType<typeof db.getDigitalEmployee> = null;
    if (employeeId) {
      employee = db.getDigitalEmployee(employeeId);
      if (!employee) throw new Error("数字员工不存在");
      if (!employee.enabled) {
        throw new Error(`数字员工「${employee.name}」已停用`);
      }
    }

    // 选择没变：直接返回。运行中重选同一个员工若继续物化，会重写它正在
    // 使用的 skills 链接与 mcp.json，技能调用可能撞上「文件刚好被删」的瞬间。
    if ((session.employeeId ?? null) === (employeeId ?? null)) return session;

    db.setSessionEmployee(sessionId, employeeId);

    /*
     * @ / 选中员工时就提前建好它的 home，首条消息不用等物化。
     * 运行中跳过：本轮正在用旧 home，新 home 交给下一轮发送前准备即可，
     * 也避免在进程运行期间改动会话运行时目录。
     * 失败不阻断切换：发送前还会再准备一次。
     */
    if (employee && !service.isRunning(sessionId)) {
      try {
        const { warnings } = await ensureSessionEmployeeRuntime(
          session,
          employee,
        );
        if (warnings.length > 0) {
          console.warn(
            `[session] 员工「${employee.name}」运行时警告：\n${warnings.join("\n")}`,
          );
        }
      } catch (err) {
        console.warn("[session] 创建员工运行时失败，将在发送时重试：", err);
      }
    }

    return db.getSession(sessionId);
  });

  /**
   * 绑定 / 切换 / 解绑会话的项目（工作目录）。
   *
   * 目录变化后旧的 CLI 会话引用不可靠，清空引用开启新上下文；
   * 本地消息记录仍然保留，并在消息流里插入一条 system 分隔提示，
   * 告诉用户「以上为旧对话，不参与当前上下文」。
   */
  handle("session:setProject", async ({ sessionId, projectId }) => {
    const session = db.getSession(sessionId);
    if (!session) return null;

    /*
     * 渲染层的 streaming 状态不是权威来源（刷新 / DevTools reload 后会丢）。
     * 运行中切换目录会改写 cwd 与 agentSessionId，而运行收尾又会把旧引用
     * 写回，导致「提示已重置上下文，实际没有」——必须在主进程拦住。
     */
    if (service.isRunning(sessionId)) {
      throw new Error("会话正在运行，请先停止再切换工作区");
    }

    const project = projectId ? db.getProject(projectId) : null;
    if (projectId && !project) throw new Error("项目不存在");

    const nextProjectId = project?.id ?? null;
    const changed = (session.projectId ?? null) !== nextProjectId;
    const cwd = service.resolveCwd(
      project?.cwd,
      db.getSetting("defaultCwd"),
      homedir(),
    );
    const hadContext =
      Boolean(session.agentSessionId) || db.hasSessionMessages(sessionId);

    /*
     * 旧会话的历史可能只存在于 CLI 侧。清空引用后就无法再回放，
     * 因此在改动 cwd 之前先把 CLI 历史导入本地，保证切换后旧对话仍可查看。
     */
    if (
      changed &&
      session.agentSessionId &&
      session.source !== "workflow" &&
      !db.hasSessionMessages(sessionId)
    ) {
      try {
        const withHistory = await service.getSessionWithHistory(sessionId);
        if (withHistory?.messages?.length) {
          db.importSessionMessages(sessionId, withHistory.messages);
        }
      } catch (err) {
        console.warn("[session] 切换工作区前导入 CLI 历史失败：", err);
      }
    }

    // 只在确实换了目录、且会话已有上下文时才重置引用
    const resetAgentSession =
      changed && Boolean(session.agentSessionId) && session.source !== "workflow";

    db.setSessionProject(sessionId, nextProjectId, cwd, resetAgentSession);

    // 有旧对话才插入分隔提示；空会话直接换目录，不需要提醒
    let marker: Message | null = null;
    if (changed && hadContext && session.source !== "workflow") {
      marker = {
        id: randomUUID(),
        role: "system",
        content: [
          {
            type: "text",
            content: project
              ? `已切换到工作区「${project.name}」。以上为旧对话，不参与新工作区的上下文。`
              : "已解除工作区绑定，后续对话使用默认目录。以上为旧对话，不参与新的上下文。",
          },
        ],
        timestamp: Date.now(),
      };
      db.saveSessionMessage(sessionId, marker);
    }

    const updated = db.getSession(sessionId);
    return updated ? { session: updated, marker } : null;
  });
}

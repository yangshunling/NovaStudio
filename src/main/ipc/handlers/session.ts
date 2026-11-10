/**
 * 会话相关 IPC：创建 / 列表 / 详情 / 重命名 / 删除 / 绑定项目
 */

import { homedir } from "os";
import type { AgentService } from "../../agents/agent-service";
import { getProvider } from "../../agents/registry";
import * as db from "../../db/sqlite";
import { handle } from "../register";

export function registerSessionHandlers(service: AgentService): void {
  /**
   * 预创建空会话。渲染进程在首条消息前调用，拿到 sessionId 后再 agent:send，
   * 这样流式事件从一开始就能按会话路由（多会话并发的关键）。
   *
   * projectId 可为 null：会话不强制绑定项目，未绑定时在默认目录运行。
   */
  handle("session:create", ({ projectId, agentId }) => {
    if (!getProvider(agentId)) {
      throw new Error(`未知 Agent：${agentId}`);
    }
    const project = projectId ? db.getProject(projectId) : null;
    if (projectId && !project) throw new Error("项目不存在");
    const cwd = service.resolveCwd(
      project?.cwd,
      db.getSetting("defaultCwd"),
      homedir(),
    );
    return db.createSession(agentId, project?.id ?? null, cwd, "新会话");
  });

  handle("session:list", () => db.listSessions());

  /**
   * 未绑定工作区时真正使用的目录。
   * 与 session:create 的回退链保持一致：设置里的 defaultCwd → 用户主目录。
   */
  handle("session:defaultCwd", () =>
    service.resolveCwd(db.getSetting("defaultCwd"), homedir()),
  );

  /** 详情：元数据 + provider 回放的历史 */
  handle("session:get", ({ id }) => service.getSessionWithHistory(id));

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
    return true;
  });

  /**
   * 绑定 / 切换 / 解绑会话的项目（工作目录）。
   * 目录变化后旧的 CLI 会话引用不可靠，清空引用开启新上下文；
   * 本地消息记录仍然保留，界面上的历史不会丢。
   */
  handle("session:setProject", ({ sessionId, projectId }) => {
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

    // 只在确实换了目录、且会话已有上下文时才重置引用
    const resetAgentSession =
      changed && Boolean(session.agentSessionId) && session.source !== "workflow";

    db.setSessionProject(sessionId, nextProjectId, cwd, resetAgentSession);
    return db.getSession(sessionId);
  });
}

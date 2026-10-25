/**
 * 会话相关 IPC：创建 / 列表 / 详情 / 重命名 / 删除 / 绑定项目
 */

import { homedir } from "os";
import type { AgentService } from "../../engine/agent-service";
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

  /** 详情：元数据 + provider 回放的历史 */
  handle("session:get", ({ id }) => service.getSessionWithHistory(id));

  handle("session:rename", ({ id, title }) => {
    db.setSessionTitle(id, title);
    return true;
  });

  handle("session:delete", ({ id }) => {
    // 先中断并清理 CLI 侧数据与缓存，再删索引行
    service.releaseSession(id);
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

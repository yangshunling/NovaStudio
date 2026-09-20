/**
 * 会话相关 IPC：创建 / 列表 / 详情 / 重命名 / 删除
 */

import type { AgentService } from "../../engine/agent-service";
import * as db from "../../db/sqlite";
import { handle } from "../register";

export function registerSessionHandlers(service: AgentService): void {
  /**
   * 预创建空会话。渲染进程在首条消息前调用，拿到 sessionId 后再 agent:send，
   * 这样流式事件从一开始就能按会话路由（多会话并发的关键）。
   */
  handle("session:create", ({ projectId, agentId }) => {
    const project = db.getProject(projectId);
    const cwd = service.resolveCwd(project?.cwd, db.getSetting("defaultCwd"));
    return db.createSession(agentId, projectId, cwd, "新会话");
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

  /** 清空某项目下的全部会话：逐个中断、清理 CLI 侧数据与缓存，再删索引行 */
  handle("session:clearProject", ({ projectId }) => {
    for (const id of db.listSessionIdsByProject(projectId)) {
      service.releaseSession(id);
      db.deleteSession(id);
    }
    return true;
  });
}

/**
 * 项目相关 IPC：列表 / 创建 / 删除
 */

import type { AgentService } from "../../engine/agent-service";
import * as db from "../../db/sqlite";
import { readGitStatus } from "../../git/status";
import { handle } from "../register";

export function registerProjectHandlers(service: AgentService): void {
  handle("project:list", () => db.listProjects());

  handle("project:create", ({ name, cwd }) => db.createProject(name, cwd));

  handle("project:delete", ({ id }) => {
    // 先逐个清理该项目下会话的 CLI 侧数据与缓存，再删索引（外键级联删会话行）
    service.releaseProject(id);
    db.deleteProject(id);
    return true;
  });

  handle("project:gitStatus", ({ cwd }) => readGitStatus(cwd));
}

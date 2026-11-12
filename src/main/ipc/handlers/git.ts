/**
 * Git IPC：工作区 Git 面板的读写操作
 *
 * 所有路径参数都是相对工作区根目录的相对路径；服务层会做越界校验。
 */

import * as db from "../../db/sqlite";
import {
  abortOperation,
  checkoutBranch,
  commitChanges,
  continueOperation,
  createBranch,
  discardPaths,
  initRepository,
  listBranches,
  pullBranch,
  pushBranch,
  readCommitFileDiff,
  readCommitFiles,
  readDiff,
  readLog,
  readStatusDetail,
  stagePaths,
  unstagePaths,
} from "../../git/detail";
import { generateCommitMessage } from "../../git/message";
import { handle } from "../register";

function projectCwd(projectId: string): string {
  const project = db.getProject(projectId);
  if (!project?.cwd) throw new Error("工作区不存在");
  return project.cwd;
}

export function registerGitHandlers(): void {
  handle("git:statusDetail", ({ projectId }) =>
    readStatusDetail(projectCwd(projectId)),
  );
  handle("git:branches", ({ projectId }) =>
    listBranches(projectCwd(projectId)),
  );
  handle("git:log", ({ projectId, limit }) =>
    readLog(projectCwd(projectId), limit),
  );
  handle("git:commitFiles", ({ projectId, hash }) =>
    readCommitFiles(projectCwd(projectId), hash),
  );
  handle("git:diff", ({ projectId, relativePath, staged }) =>
    readDiff(projectCwd(projectId), relativePath, staged),
  );
  handle("git:commitFileDiff", ({ projectId, hash, relativePath, oldPath }) =>
    readCommitFileDiff(projectCwd(projectId), hash, relativePath, oldPath),
  );
  handle("git:stage", ({ projectId, paths }) =>
    stagePaths(projectCwd(projectId), paths),
  );
  handle("git:unstage", ({ projectId, paths }) =>
    unstagePaths(projectCwd(projectId), paths),
  );
  handle("git:commit", ({ projectId, message }) =>
    commitChanges(projectCwd(projectId), message),
  );
  handle("git:generateCommitMessage", ({ projectId }) =>
    generateCommitMessage(projectCwd(projectId)),
  );
  handle("git:checkoutBranch", ({ projectId, branch }) =>
    checkoutBranch(projectCwd(projectId), branch),
  );
  handle("git:createBranch", ({ projectId, name }) =>
    createBranch(projectCwd(projectId), name),
  );
  handle("git:init", ({ projectId }) =>
    initRepository(projectCwd(projectId)),
  );
  handle("git:push", ({ projectId, branch }) =>
    pushBranch(projectCwd(projectId), branch),
  );
  handle("git:pull", ({ projectId }) =>
    pullBranch(projectCwd(projectId)),
  );
  handle("git:discard", ({ projectId, paths }) =>
    discardPaths(projectCwd(projectId), paths),
  );
  handle("git:continueOperation", ({ projectId }) =>
    continueOperation(projectCwd(projectId)),
  );
  handle("git:abortOperation", ({ projectId }) =>
    abortOperation(projectCwd(projectId)),
  );
}

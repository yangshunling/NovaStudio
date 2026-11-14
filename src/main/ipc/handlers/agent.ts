/**
 * Agent 相关 IPC：检测 / 发送 / 中断
 */

import type { SendAgentResult } from "../../../shared/contracts/ipc";
import { getProvider } from "../../agents/registry";
import {
  getClaudeSettingsView,
  saveClaudeSettings,
} from "../../agents/claude/settings";
import { listClaudeModels } from "../../agents/claude/models";
import type { AgentService } from "../../agents/agent-service";
import * as db from "../../db/sqlite";
import { flushEvents, push } from "../push";
import { handle } from "../register";
import { revealPath } from "../nativeUi";
import { BASE_CHAT_NAME } from "../../agents/chat-identity";
import { prepareSessionChatRun } from "../../sessions/runtime";
import { errorMessage } from "../../../shared/error";
import type {
  DigitalEmployee,
  DisplayReference,
  InputImage,
} from "../../../shared/types";

/**
 * 同一会话的发送占位。
 *
 * agent:send 在 service.run 之前还有 prepareSessionChatRun / touchSession 等
 * 副作用，而 service.run 的运行锁要到 provider.start 之后才生效。没有这层
 * 占位时，双击发送 / 刷新后重发会让两次准备并发改写同一份运行时目录。
 */
const pendingSends = new Set<string>();
/** 发送尚在准备阶段时用户点了停止：准备完成后不再启动本轮 */
const canceling = new Set<string>();

/** 单条消息的图片上限：与渲染层输入区保持一致 */
const MAX_IMAGES = 8;
/** base64 总量上限，约 20MB 原始字节 */
const MAX_IMAGE_TOTAL_BASE64 = 28 * 1024 * 1024;

/**
 * IPC 边界校验：渲染层不可信，超限或缺字段直接拒绝，
 * 避免一次消息把内存 / DB / CLI stdin 同时撑爆。
 */
function validateImages(images?: InputImage[]): string | null {
  if (!images || images.length === 0) return null;
  if (images.length > MAX_IMAGES) {
    return `单条消息最多 ${MAX_IMAGES} 张图片`;
  }
  let total = 0;
  for (const image of images) {
    if (
      !image ||
      typeof image.mediaType !== "string" ||
      !image.mediaType.startsWith("image/") ||
      typeof image.data !== "string" ||
      !image.data
    ) {
      return "图片数据不合法";
    }
    total += image.data.length;
  }
  if (total > MAX_IMAGE_TOTAL_BASE64) {
    return "图片总大小超过限制（约 20MB）";
  }
  return null;
}

export function registerAgentHandlers(service: AgentService): void {
  handle("agent:detect", async () => {
    const agents = await service.listAgentInfos();
    push("agents:detected", agents);
    return agents;
  });

  handle("agent:settings:get", ({ agentId }) => {
    if (agentId !== "claude") {
      throw new Error(`暂不支持编辑该 Agent 的本机配置：${agentId}`);
    }
    return getClaudeSettingsView();
  });

  handle("agent:settings:save", ({ draft }) => saveClaudeSettings(draft));

  /** 按当前 Base URL / API Key 拉取可用模型（仅 Claude 兼容端点） */
  handle(
    "agent:models:list",
    ({ agentId, baseUrl, apiKey, authMode, customHeaders }) => {
      if (agentId !== "claude") {
        throw new Error(`暂不支持获取该 Agent 的模型列表：${agentId}`);
      }
      return listClaudeModels(baseUrl, apiKey, authMode, customHeaders);
    },
  );

  /** 安装 Agent 到本机；输出实时推送到设置页 */
  handle("agent:install:run", async ({ agentId }) => {
    const provider = getProvider(agentId);
    if (!provider?.install) {
      throw new Error(`该 Agent 不支持由 Nova 安装：${agentId}`);
    }
    return provider.install((chunk) =>
      push("agent:install:progress", { agentId, chunk }),
    );
  });

  /** 检查 Agent 是否有新版本（不修改本机安装） */
  handle("agent:upgrade:check", ({ agentId }) => {
    const provider = getProvider(agentId);
    if (!provider?.checkUpgrade) {
      throw new Error(`该 Agent 不支持升级检测：${agentId}`);
    }
    return provider.checkUpgrade();
  });

  /** 升级 Agent 到最新版本；输出实时推送到设置页 */
  handle("agent:upgrade:run", async ({ agentId }) => {
    const provider = getProvider(agentId);
    if (!provider?.upgrade) {
      throw new Error(`该 Agent 不支持升级：${agentId}`);
    }
    return provider.upgrade((chunk) =>
      push("agent:upgrade:progress", { agentId, chunk }),
    );
  });

  /** 打开某个 Agent 的本机配置目录 */
  handle("agent:openConfigDir", async ({ agentId }) => {
    const provider = getProvider(agentId);
    const config = provider?.configInfo?.();
    if (!config?.configPath) return false;

    return revealPath(config.configPath);
  });

  /**
   * 统一发送：主进程按会话是否已存会话引用、以及 provider 是否支持多轮，
   * 决定新建还是恢复（判断逻辑在 AgentService 内，此处不重复）。
   */
  const sendAgent = async ({
    sessionId,
    prompt,
    display,
    images,
    references,
    employeeId,
  }: {
    sessionId: string;
    prompt: string;
    /** 聊天里展示的正文；缺省为 prompt */
    display?: string;
    images?: InputImage[];
    /** 引用标签的展示信息：只落库，不送给 Agent */
    references?: DisplayReference[];
    employeeId?: string | null;
  }): Promise<SendAgentResult> => {
    const session = db.getSession(sessionId);
    if (!session) return { ok: false, error: `会话不存在: ${sessionId}` };

    const cwd = service.resolveCwd(session.cwd, db.getSetting("defaultCwd"));

    /*
     * 本轮回答者：显式传入优先，否则沿用会话当前的员工。
     * null 表示不指定员工，使用会话的 base-home。
     */
    const requestedEmployeeId =
      employeeId !== undefined ? employeeId : (session.employeeId ?? null);

    let employee: DigitalEmployee | null = null;
    if (requestedEmployeeId) {
      const found = db.getDigitalEmployee(requestedEmployeeId);
      if (!found) {
        return {
          ok: false,
          error: "本次会话选择的数字员工已不存在，请重新选择员工",
        };
      }
      if (!found.enabled) {
        return {
          ok: false,
          error: `数字员工「${found.name}」已停用，请启用后再继续本次会话`,
        };
      }
      employee = found;
    }

    // 显式选择在运行前落库，保证本轮与界面选择一致
    if (
      employeeId !== undefined &&
      requestedEmployeeId !== session.employeeId
    ) {
      db.setSessionEmployee(sessionId, requestedEmployeeId);
    }

    /*
     * 一个会话一份 projects：base-home / 员工 home 只切配置目录。
     * 必须先落库 active home 再启动，历史回放与 --resume 都按 config_dir
     * 定位 projects 下的 CLI 会话文件。
     */
    let run: Awaited<ReturnType<typeof prepareSessionChatRun>>;
    try {
      run = await prepareSessionChatRun(session, employee);
    } catch (err) {
      return {
        ok: false,
        error: `会话运行环境准备失败：${errorMessage(err)}`,
      };
    }
    if (run.configDir) db.setSessionConfigDir(sessionId, run.configDir);
    if (run.warnings.length > 0) {
      console.warn(
        `[agent:send] 会话运行时警告：\n${run.warnings.join("\n")}`,
      );
    }

    /*
     * 用户在准备运行时点过停止：此时还没有 RunSession，service.abort 找不到
     * 句柄，只能由 canceling 标记在这里刹车。尚未 touchSession、也未落用户
     * 消息，因此取消是干净的无副作用退出。
     */
    if (canceling.has(sessionId)) {
      canceling.delete(sessionId);
      flushEvents();
      push("agent:aborted", { sessionId });
      return { ok: true, exitCode: -1, duration: 0, canceled: true };
    }

    /*
     * 记录用户消息：刷新索引（首条消息写标题），正文不入库。
     * 标题取聊天里展示的正文，而不是含引用说明的完整 prompt，
     * 否则首条消息带引用时标题会变成「请读取另一个会话的原始记录…」。
     */
    const titleSource =
      (display ?? prompt).trim() || references?.[0]?.name || "[图片]";
    db.touchSession(sessionId, {
      title:
        (session.messageCount ?? 0) === 0
          ? titleSource.slice(0, 40)
          : undefined,
      countDelta: 1,
    });

    /*
     * 发言者前缀只加在送入 CLI 的上下文里。
     *
     * 同一会话的 projects 由员工与通用助手共用，历史消息本身不带身份；
     * 切换员工后，上一位的「你是谁」自述仍留在上下文中。每轮用户消息前
     * 标注 @回答者，模型才能从上下文区分哪句话由谁说出，避免串台。
     * 落库与界面展示仍使用原始 prompt。
     */
    const speaker = employee?.name ?? BASE_CHAT_NAME;
    // 纯图片提问没有正文：只留发言者标记，避免尾部多余空格进入上下文
    const contextPrompt = prompt.startsWith(`@${speaker}`)
      ? prompt
      : prompt.trim()
        ? `@${speaker} ${prompt}`
        : `@${speaker}`;

    const outcome = await service.run({
      sessionId,
      prompt,
      displayPrompt: display,
      displayReferences: references,
      images,
      contextPrompt,
      cwd,
      // 聊天是唯一有用户在场的入口：允许把工具授权询问弹给用户
      interactivePermissions: true,
      // 落库时记到本轮消息上：历史回复按当时的回答者显示头像
      employeeId: requestedEmployeeId,
      ...(run.env ? { env: run.env } : {}),
      ...(run.envRemove ? { envRemove: run.envRemove } : {}),
      extraArgs: run.extraArgs,
      ...(run.systemPrompt
        ? { opts: { systemPrompt: run.systemPrompt } }
        : {}),
      // 覆盖历史导入 await 期间到达的停止请求
      shouldCancel: () => canceling.has(sessionId),
    });
    if (outcome.canceled) {
      // 取消发生在 touchSession 之后、用户消息落库之前：撤回计数
      db.touchSession(sessionId, { countDelta: -1 });
      flushEvents();
      push("agent:aborted", { sessionId });
      return { ok: true, exitCode: -1, duration: 0, canceled: true };
    }
    if (!outcome.ok) {
      // 运行没起来：把刚才记的用户消息撤回，避免消息数虚增导致
      // 「首条消息自动命名」和侧栏计数都失真。
      db.touchSession(sessionId, { countDelta: -1 });
      return { ok: false, error: outcome.error ?? "运行失败" };
    }

    flushEvents();

    // 被用户中断的会话不记为完成：推送独立的 aborted 终态
    if (!outcome.aborted) {
      db.touchSession(sessionId, { countDelta: 1 });
      push("agent:done", {
        sessionId,
        exitCode: outcome.exitCode,
        duration: outcome.duration,
      });
    } else {
      push("agent:aborted", { sessionId });
    }

    return {
      ok: true,
      exitCode: outcome.exitCode,
      duration: outcome.duration,
    };
  };

  handle("agent:send", async (input) => {
    const imageError = validateImages(input.images);
    if (imageError) return { ok: false, error: imageError };
    if (pendingSends.has(input.sessionId)) {
      return { ok: false, error: "会话正在运行，请等待本次执行结束" };
    }
    pendingSends.add(input.sessionId);
    try {
      return await sendAgent(input);
    } finally {
      pendingSends.delete(input.sessionId);
      canceling.delete(input.sessionId);
    }
  });

  /** 中断指定会话（多会话并发时互不影响） */
  handle("agent:abort", ({ sessionId }) => {
    const aborted = service.abort(sessionId);
    // 还在准备阶段（尚未 provider.start）：登记取消，准备完成后直接刹车
    if (!aborted && pendingSends.has(sessionId)) canceling.add(sessionId);
    flushEvents();
    return aborted || (canceling.has(sessionId) && pendingSends.has(sessionId));
  });

  /** 回答工具授权询问；请求已超时或被中断时返回 ok:false */
  handle("agent:permission:respond", ({ sessionId, requestId, decision }) => {
    if (decision.behavior !== "allow" && decision.behavior !== "deny") {
      return { ok: false, error: "非法的授权结果" };
    }
    return service.respondPermission(sessionId, requestId, decision);
  });

  /** 渲染层刷新 / 重载后恢复仍待处理的授权询问 */
  handle("agent:permission:list", () => service.listPendingPermissions());
}

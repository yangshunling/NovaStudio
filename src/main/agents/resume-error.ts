/**
 * 判断 CLI 的失败诊断是否属于「会话引用已失效」。
 *
 * 宿主要据此清空 sessions.agent_session_id：否则后续每次发送都会
 * 继续 --resume 同一个不存在的会话，永久失败。
 *
 * 目前确认的文案（claude 2.1.x，--resume 一个不存在的 id）：
 *   No conversation found with session ID: <id>
 * 不同版本 / 兼容网关的措辞可能不同，这里覆盖几个常见变体。
 */
export function isResumeFailure(message: string | undefined): boolean {
  if (!message) return false;
  return /No conversation found with session ID|could not find conversation|session .* not found|unable to resume/i.test(
    message,
  );
}

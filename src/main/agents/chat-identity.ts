/**
 * 聊天身份常量
 *
 * 「通用助手」是“不绑定数字员工”这一状态的外显名称，属于宿主概念，
 * 不属于任何具体 Agent。放在 agents 根目录，聊天运行时与 provider 都可以
 * 引用，而不会反向依赖 sessions/runtime（避免注册表 ↔ 会话运行时循环依赖）。
 */

export const BASE_CHAT_NAME = "通用助手";

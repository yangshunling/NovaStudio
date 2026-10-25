/**
 * 连接密钥的本机安全存储
 *
 * 优先使用 Electron safeStorage（Windows 走 DPAPI，macOS 走 Keychain，
 * Linux 走系统 keyring）；不可用时退化为带标记的 Base64 明文，
 * 并在返回值里如实标注 storage，供 UI 提示风险。
 *
 * 存储格式：
 *   enc:v1:<base64>    safeStorage 加密
 *   plain:v1:<base64>  明文兜底（仅编码，不是加密）
 *   ""                 未保存
 */

import { safeStorage } from "electron";

const ENCRYPTED_PREFIX = "enc:v1:";
const PLAINTEXT_PREFIX = "plain:v1:";

export type SecretStorage = "encrypted" | "plaintext" | "none";

/** 加密一个密钥；空字符串直接返回未保存状态 */
export function encryptSecret(secret: string): {
  value: string;
  storage: SecretStorage;
} {
  if (!secret) return { value: "", storage: "none" };

  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: ENCRYPTED_PREFIX + safeStorage.encryptString(secret).toString("base64"),
        storage: "encrypted",
      };
    }
  } catch {
    // 密钥环不可用：继续走明文兜底，由调用方在 UI 上提示
  }

  return {
    value: PLAINTEXT_PREFIX + Buffer.from(secret, "utf8").toString("base64"),
    storage: "plaintext",
  };
}

/** 解密已保存的密钥；无法解密时返回空字符串（调用方按“未配置”处理） */
export function decryptSecret(stored: string): string {
  if (!stored) return "";

  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    try {
      const buffer = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
      return safeStorage.decryptString(buffer);
    } catch {
      return "";
    }
  }

  if (stored.startsWith(PLAINTEXT_PREFIX)) {
    try {
      return Buffer.from(stored.slice(PLAINTEXT_PREFIX.length), "base64").toString(
        "utf8",
      );
    } catch {
      return "";
    }
  }

  // 兼容未来可能出现的无前缀旧数据
  return stored;
}

/** 脱敏后的尾号提示；只用于展示 */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}

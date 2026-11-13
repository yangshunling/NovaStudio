/**
 * 关于与更新：产品信息、运行环境、版本更新
 */

import { useEffect, useState } from "react";
import logoUrl from "../../assets/logo.png";
import { ipc } from "../../lib/ipc";
import { confirmDialog } from "../../stores/confirm";
import type { AppInfo, UpdaterState } from "@shared/types";
import { Button } from "../ui/Button";
import { SettingsCard, SettingsPage } from "./SettingsLayout";

function platformLabel(platform: string): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform || "未知";
  }
}

/** 关于页里「名称 - 值」的一行 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="ui-type-note text-text-muted">{label}</span>
      <span className="select-text ui-type-note text-text-secondary">
        {value}
      </span>
    </div>
  );
}

function UpdateCard() {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    void ipc
      .getUpdaterState()
      .then((next) => setState(next))
      .catch(() => {});
    // 主进程是唯一状态源：检查 / 下载 / 下载完成都通过推送同步
    return ipc.on.updaterChanged((next) => setState(next));
  }, []);

  const handleCheck = async () => {
    setState(await ipc.checkForUpdates());
  };

  const handleDownload = async () => {
    await ipc.downloadUpdate();
  };

  const handleInstall = async () => {
    const confirmed = await confirmDialog({
      title: "重启并安装更新？",
      message:
        "应用会立即关闭并安装新版本。正在运行的会话或工作流会被中断，请确认没有重要任务在执行。",
      confirmLabel: "重启并安装",
    });
    if (!confirmed) return;
    await ipc.installUpdate();
  };

  if (!state) {
    return (
      <SettingsCard title="应用更新" description="正在读取更新状态…" />
    );
  }

  const { phase, version, percent, message, supported } = state;

  return (
    <SettingsCard
      title="应用更新"
      description={
        supported
          ? "通过 GitHub Releases 分发，下载完成后可自行选择何时重启安装。"
          : "开发模式下不可用，打包安装后生效。"
      }
    >
      <div className="px-4 py-3">
        {phase === "checking" && (
          <p className="ui-type-body text-text-secondary">正在检查更新…</p>
        )}
        {phase === "up-to-date" && (
          <p className="ui-type-body text-text-secondary">已是最新版本。</p>
        )}
        {phase === "available" && (
          <p className="ui-type-body text-text-secondary">
            发现新版本{" "}
            <span className="font-semibold text-text">v{version}</span>
            ，可以立即下载。
          </p>
        )}
        {phase === "downloading" && (
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 ui-type-note text-text-muted">
              正在下载更新… {percent}%
            </p>
          </div>
        )}
        {phase === "downloaded" && (
          <p className="ui-type-body text-text-secondary">
            v{version} 已下载完成，重启应用即可完成安装。
          </p>
        )}
        {phase === "error" && (
          <p className="ui-type-body text-error">
            {message ?? "检查更新失败。"}
          </p>
        )}
        {phase === "idle" && message && (
          <p className="ui-type-note text-text-muted">{message}</p>
        )}

        <div className="mt-3 flex items-center gap-2">
          {supported &&
            (phase === "idle" || phase === "up-to-date" || phase === "error") && (
              <Button size="sm" onClick={() => void handleCheck()}>
                检查更新
              </Button>
            )}
          {phase === "available" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void handleDownload()}
            >
              下载更新
            </Button>
          )}
          {phase === "downloaded" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void handleInstall()}
            >
              重启并安装
            </Button>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}

export function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void ipc
      .getAppInfo()
      .then((next) => setInfo(next))
      .catch(() => {});
  }, []);

  return (
    <SettingsPage title="关于与更新" description="产品信息、运行环境与版本更新。">
      {/* 品牌区 */}
      <div className="flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-4">
        <img
          src={logoUrl}
          alt="Nova Studio"
          className="h-14 w-14 shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0">
          <p className="ui-type-item font-semibold text-text">Nova Studio</p>
          <p className="mt-0.5 ui-type-note text-text-muted">
            AI 智能体 CLI 的桌面 GUI 客户端
          </p>
        </div>
      </div>

      <SettingsCard>
        <InfoRow label="版本" value={info ? `v${info.version}` : "—"} />
        <InfoRow label="Electron" value={info?.electron || "—"} />
        <InfoRow label="Chromium" value={info?.chrome || "—"} />
        <InfoRow label="Node.js" value={info?.node || "—"} />
        <InfoRow
          label="系统"
          value={info ? `${platformLabel(info.platform)} · ${info.arch}` : "—"}
        />
      </SettingsCard>

      <UpdateCard />
    </SettingsPage>
  );
}

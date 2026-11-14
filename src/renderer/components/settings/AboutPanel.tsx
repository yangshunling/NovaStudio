/**
 * 关于与更新：产品信息、运行环境、版本更新
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import logoUrl from "../../assets/logo.png";
import { ipc } from "../../lib/ipc";
import { confirmDialog } from "../../stores/confirm";
import { setUpdaterState, useUpdaterStore } from "../../stores/updater";
import type { AppInfo } from "@shared/types";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { Spinner } from "../ui/Spinner";
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

/** 关于页的一行：左侧名称，右侧值或操作 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="ui-type-note text-text-muted">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

/** 「名称 - 值」的一行 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Row label={label}>
      <span className="select-text ui-type-note text-text-secondary">
        {value}
      </span>
    </Row>
  );
}

function UpdateCard() {
  // 更新状态由 App 启动时统一同步，打开设置页不会重新订阅
  const state = useUpdaterStore((s) => s.state);

  const handleCheck = async () => {
    setUpdaterState(await ipc.checkForUpdates());
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
  const versionLabel = version ? `v${version}` : "新版本";

  return (
    <SettingsCard
      title="应用更新"
      description={
        supported
          ? "通过 GitHub Releases 分发，下载完成后可自行选择何时重启安装。"
          : "开发模式下不可用，打包安装后生效。"
      }
    >
      {phase === "idle" && (
        <Row label="更新状态">
          <span className="ui-type-note text-text-muted">
            {supported ? "尚未检查" : "开发模式下不可用"}
          </span>
          {supported && (
            <Button size="xs" onClick={() => void handleCheck()}>
              检查更新
            </Button>
          )}
        </Row>
      )}

      {phase === "checking" && (
        <Row label="更新状态">
          <Spinner className="h-3.5 w-3.5 text-text-muted" />
          <span className="ui-type-note text-text-secondary">
            正在检查更新…
          </span>
        </Row>
      )}

      {phase === "up-to-date" && (
        <Row label="更新状态">
          <Pill toneClassName="bg-success/10 text-success">已是最新版本</Pill>
          <Button size="xs" onClick={() => void handleCheck()}>
            检查更新
          </Button>
        </Row>
      )}

      {phase === "available" && (
        <Row label="更新状态">
          <span className="ui-type-note text-text-secondary">发现新版本</span>
          <Pill variant="accent">{versionLabel}</Pill>
          <Button
            size="xs"
            variant="primary"
            onClick={() => void handleDownload()}
          >
            下载更新
          </Button>
        </Row>
      )}

      {phase === "downloading" && (
        <>
          <Row label="更新状态">
            <span className="ui-type-note text-text-secondary">
              正在下载 {versionLabel}
            </span>
          </Row>
          <div className="flex items-center justify-between gap-4 px-4 py-2.5">
            <span className="ui-type-note text-text-muted">下载进度</span>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-active">
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="w-9 shrink-0 text-right tabular-nums ui-type-note text-text-secondary">
                {percent}%
              </span>
            </div>
          </div>
        </>
      )}

      {phase === "downloaded" && (
        <Row label="更新状态">
          <Pill toneClassName="bg-success/10 text-success">
            {versionLabel} 已下载
          </Pill>
          <Button
            size="xs"
            variant="primary"
            onClick={() => void handleInstall()}
          >
            重启并安装
          </Button>
        </Row>
      )}

      {phase === "error" && (
        <>
          <Row label="更新状态">
            <Pill variant="error">检查失败</Pill>
            {supported && (
              <Button size="xs" onClick={() => void handleCheck()}>
                重试
              </Button>
            )}
          </Row>
          <p className="px-4 py-2.5 ui-type-note leading-relaxed text-error">
            {message ?? "检查更新失败。"}
          </p>
        </>
      )}
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

      <SettingsCard
        title="版本信息"
        description="当前安装的客户端与运行环境。"
      >
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

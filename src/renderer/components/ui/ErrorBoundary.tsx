/**
 * 错误边界
 *
 * 渲染进程任一组件抛错时兜底展示，避免整屏白屏（数据仍安全地留在主进程）。
 * 提供「重试」与「重新加载」两个出口。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[nova] 界面渲染异常：", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg px-8 text-text">
        <h1 className="text-title font-semibold">界面出现异常</h1>
        <p className="max-w-lg text-center text-meta text-text-muted">
          这是界面层的渲染错误，会话与设置数据都保存在主进程，重新加载即可恢复。
        </p>
        <pre className="max-h-40 max-w-2xl overflow-auto rounded-md border border-error bg-error-bg px-4 py-3 text-caption text-error">
          {error.message}
        </pre>
        <div className="flex items-center gap-2">
          <button className="ui-btn-ghost rounded-full px-4 py-2 text-meta" onClick={this.handleReset}>
            重试
          </button>
          <button className="ui-btn-primary rounded-full px-4 py-2 text-meta" onClick={this.handleReload}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

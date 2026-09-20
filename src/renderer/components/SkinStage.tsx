/**
 * 装饰舞台
 *
 * 完全由当前皮肤的 chrome 声明驱动：没声明 chrome 的皮肤（纯色皮肤）根本不挂载舞台，
 * 因此组件里不出现任何皮肤 id，也不做「哪套皮肤要不要背景」的判断。
 *
 * 舞台挂在内容区内部（而非视口），随内容区尺寸自适应。
 * 美术资源授权 CC BY-NC-SA 4.0，署名信息见 resources/NOTICE.md（随包分发）。
 */

import { useSkin } from "../hooks/useTheme";

export function SkinStage() {
  const { chrome } = useSkin();
  if (!chrome) return null;

  return (
    <div aria-hidden="true" className="ui-stage">
      {chrome.background && (
        <div
          className="ui-stage-bg"
          style={{ backgroundImage: `url(${chrome.background})` }}
        />
      )}

      {/* 可读性轻纱：让消息区文字始终清晰 */}
      <div className="ui-stage-veil" />

      {chrome.left && (
        <img
          src={chrome.left}
          alt=""
          className="ui-stage-figure ui-stage-figure-left"
          draggable={false}
        />
      )}
      {chrome.right && (
        <img
          src={chrome.right}
          alt=""
          className="ui-stage-figure ui-stage-figure-right"
          draggable={false}
        />
      )}
    </div>
  );
}

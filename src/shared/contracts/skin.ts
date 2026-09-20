/**
 * 皮肤契约层
 *
 * 一套皮肤 = 一份 SkinVariant + 一份 tokens.css。
 *
 * 关键约束：宿主（组件 / 代码高亮 / 设置面板 / 启动引导）**不得出现任何具体皮肤 id**，
 * 一切差异都由本结构描述。新增一套皮肤只需新增
 * src/renderer/skins/<id>/{index.ts,tokens.css}，其余文件零改动。
 */

/** 装饰图层：内容区背后的一层皮肤专属美术资源。不声明则该皮肤无舞台。 */
export interface SkinChrome {
  /** 背景图，铺满内容区 */
  background?: string;
  /** 左下立绘 */
  left?: string;
  /** 右下立绘 */
  right?: string;
}

export interface SkinVariant {
  /** 唯一标识，写入 <html data-theme> 与设置存储 */
  id: string;
  displayName: string;
  description: string;
  /** 明暗属性。宿主据此决定与皮肤无关的通用行为（如原生控件配色） */
  appearance: "light" | "dark";
  /** Shiki 代码高亮主题名。由皮肤自己指定，宿主不做任何推断 */
  codeTheme: string;
  /** 设置面板色卡要展示的 token 名，数组顺序即展示顺序 */
  preview: readonly string[];
  /** 排序权重，小的在前 */
  order: number;
  /** 装饰图层，缺省表示纯色皮肤 */
  chrome?: SkinChrome;
}

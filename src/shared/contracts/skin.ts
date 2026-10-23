/**
 * 皮肤契约层
 *
 * 一套皮肤 = 一份 SkinVariant + 一份 tokens.css。
 *
 * 关键约束：宿主（组件 / 代码高亮 / 设置面板 / 启动引导）**不得出现任何具体皮肤 id**，
 * 一切差异都由本结构描述。新增一套皮肤只需新增
 * src/renderer/skins/<id>/{index.ts,tokens.css}，其余文件零改动。
 */

export interface SkinVariant {
  /** 唯一标识，写入 <html data-theme> 与设置存储 */
  id: string;
  displayName: string;
  description: string;
  /** 明暗属性。宿主据此决定与皮肤无关的通用行为（如原生控件配色） */
  appearance: "light" | "dark";
  /** Shiki 代码高亮主题名。由皮肤自己指定，宿主不做任何推断 */
  codeTheme: string;
  /** 排序权重，小的在前 */
  order: number;
}

/**
 * 会话标题的纯函数：本地兜底压缩 + 模型输出清洗
 *
 * 首条消息发送时先把问题用本地规则压成一句短标题立即展示，
 * 同时后台交给模型总结成更准确的短标题。模型结果必须经过
 * normalizeSessionTitle 清洗后才能落库，避免引号、前缀、解释性文字混进列表。
 */

/** 标题上限：十几个字，兼顾信息量与侧栏宽度 */
export const SESSION_TITLE_MAX_CHARS = 16;

/** 送进模型的问题长度上限，避免把整段代码 / 日志塞进标题请求 */
const PROMPT_QUESTION_LIMIT = 1200;

/**
 * 标题结构化输出的 schema。
 *
 * 由 provider 传给 CLI 的 `--json-schema`，让模型直接产出 `{ title }`，
 * 而不是在自然语言里夹一句「以下是标题：…」。长度不写进 schema：
 * schema 校验失败会让整次生成失败，交给 normalizeSessionTitle 截断更稳。
 */
export const SESSION_TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: `会话标题，不超过 ${SESSION_TITLE_MAX_CHARS} 个字`,
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

/**
 * 从 provider 的返回值里取出标题正文。
 *
 * 结构化输出是 `{"title":"…"}`；不支持 schema 的 provider 会返回纯文本。
 * 两种情况都兼容，最终仍交给 normalizeSessionTitle 做统一清洗。
 */
export function extractStructuredTitle(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string") return value;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { title?: unknown }).title === "string"
    ) {
      return (value as { title: string }).title;
    }
  } catch {
    // 不是 JSON：按纯文本处理
  }
  return raw;
}

/** 构造标题总结请求：只要求一句话，模型不需要解释过程 */
export function buildSessionTitlePrompt(question: string): string {
  const text = question
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, PROMPT_QUESTION_LIMIT);

  return [
    "你负责给聊天会话起标题。",
    `把下面用户的第一条问题概括成不超过 ${SESSION_TITLE_MAX_CHARS} 个字的标题。`,
    "只保留关键对象和动作，去掉寒暄、称呼和语气词。",
    "不要标点、引号、书名号，也不要解释或输出多个候选。",
    "只输出标题本身。",
    "",
    "用户问题：",
    text,
  ].join("\n");
}

/** 模型可能把标题包在引号 / 反引号 / Markdown 标题里，统一剥掉 */
const WRAP_PUNCTUATION = /["'“”‘’「」『』《》]/g;
const TRAILING_PUNCTUATION = /[。．.！!？?；;，,、：:]+$/;

/**
 * 显式标签：「标题：」「标题的内容：」「标题是」「会话标题为：」。
 * 标签是最可信的边界——模型爱先寒暄再给标题，按标签切就不会把
 * 「你好，以下是…」带进标题。
 */
const TITLE_LABEL =
  /标题(?:的?内容)?\s*(?:(?:是|为)\s*[:：]?\s*|[:：]\s*)/;

/** 标签后紧跟引号的候选；只认紧贴标签的那一段，避免从解释文字里误抓引号 */
const QUOTED_HEAD =
  /^\s*[「“"'`『《]{1}([^」”"'`』》\n]{1,40})[」”"'`』》]{1}/;

/** 整段就是一个引号包裹的标题 */
const QUOTED_WHOLE =
  /^\s*[「“"'`『《]{1}([^」”"'`』》]{1,80})[」”"'`』》]{1}\s*$/;

/** 模型常见的开场客套 / 引导语，提取前先剥掉 */
const GREETING_PREFIX =
  /^(?:你好|您好|好的|好|当然可以|当然|没问题|可以|以下是|这是|这里是|给你|已经为你|为你(?:生成|准备|总结)的?)[\s，,。.!！:：]*/;

/**
 * 裸标签，例如「标题 新建会话…」。
 * 必须带冒号或空白分隔：否则「会话标题自动总结」这种以「标题」开头的
 * 合法标题会被误删成「自动总结」。
 */
const BARE_LABEL = /^(?:会话)?标题(?:的?内容)?(?:\s*[:：]\s*|\s+)/;

/** 标题之后紧跟的解释性从句：「…，如果你想调整可以告诉我」 */
const EXPLANATION_TAIL =
  /[,，;；]\s*(?:如果|如需|需要的话|需要|希望|你可以|可随时|仅供参考|理由|说明)[\s\S]*$/;

/** 按 Unicode 码点截断，避免把 emoji 劈成半个代理对 */
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** 压平空白；中文之间的空格是排版噪声（移除代码 / 链接后尤其明显） */
function collapseSpaces(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(
      /([^\x00-\x7f])\s+(?=[^\x00-\x7f])/g,
      "$1",
    )
    .trim();
}

/** 去掉 Markdown 标记、包裹引号、尾部标点，并压平空白 */
function cleanTitleText(text: string): string {
  return collapseSpaces(
    text
      // 行首的 Markdown 标题 / 列表符号（含 1. 2. 这类有序列表）
      .replace(/^#{1,6}\s*/, "")
      .replace(/^(?:[-*+]|\d+[.、)])\s+/, "")
      .replace(/^\*\*(.*)\*\*$/, "$1")
      .replace(/^`+|`+$/g, "")
      // 包裹用的引号 / 书名号（提取阶段已用过，这里只做兜底清理）
      .replace(WRAP_PUNCTUATION, ""),
  )
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
}

/** 超长时优先在自然停顿处截断，否则硬切到上限 */
function limitTitleChars(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;

  const head = truncateChars(text, max);
  const clauseIdx = Math.max(
    head.lastIndexOf("，"),
    head.lastIndexOf(","),
    head.lastIndexOf("；"),
    head.lastIndexOf(";"),
    head.lastIndexOf("、"),
    head.lastIndexOf("："),
    head.lastIndexOf(":"),
  );
  if (clauseIdx >= Math.floor(max / 2)) {
    return head.slice(0, clauseIdx).trim();
  }
  return head.trim();
}

/**
 * 从模型返回里提取标题。
 *
 * 不假设模型「只输出一行」，按可信度依次尝试：
 * 1. 显式标签（`标题：` / `标题的内容是`）之后的内容；
 * 2. 紧贴标签、或被整段包裹的引号内容；
 * 3. 剥掉开场客套后，取第一句，并在「如果 / 如需…」这类解释从句前截断。
 *
 * 空结果返回空串，由调用方回退到临时标题，而不是把空标题写进数据库。
 */
export function normalizeSessionTitle(
  raw: string,
  max = SESSION_TITLE_MAX_CHARS,
): string {
  if (!raw) return "";

  // 去掉代码围栏标记但保留围栏内的文本
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*```[^\n]*$/gm, " ")
    .trim();
  if (!text) return "";

  let candidate: string;
  /** 是否已由标签 / 引号划出边界：可信内容不再做「裸标签」剥离，避免误伤标题本身 */
  let trusted = false;
  // 整段就是一个引号包裹的标题：优先采用，避免标题内部含「标题：」时被标签规则误切
  const whole = QUOTED_WHOLE.exec(text);
  const label = TITLE_LABEL.exec(text);
  if (whole) {
    candidate = whole[1];
    trusted = true;
  } else if (label) {
    candidate = text.slice(label.index + label[0].length);
    // 标签后紧跟引号：引号是模型自己划出的边界，最可信
    const quoted = QUOTED_HEAD.exec(candidate);
    if (quoted) candidate = quoted[1];
    trusted = true;
  } else {
    candidate = text;
  }

  // 剥开场客套；裸标签只在没有可信边界时才剥（「会话标题自动总结」是合法标题）
  for (let i = 0; i < 4; i += 1) {
    let next = candidate.replace(GREETING_PREFIX, "").trim();
    if (!trusted) next = next.replace(BARE_LABEL, "").trim();
    if (next === candidate) break;
    candidate = next;
  }
  if (!candidate) return "";

  // 只取第一句；多行解释 / 列举不会混进标题
  candidate = candidate.split(/[。！？!?\n]/)[0].trim();
  // 「…，如果你想调整…」这类尾巴
  candidate = candidate.replace(EXPLANATION_TAIL, "").trim();

  const cleaned = cleanTitleText(candidate);
  if (!cleaned) return "";

  /*
   * 走到这里还是纯客套，说明没有提取到实质内容：
   * 返回空串让调用方保留临时标题，好过写一句「你好」进数据库。
   */
  if (
    /^(?:你好|您好|好的|当然|没问题|以下是|这是|这里是|很(?:高兴|乐意)|希望)/.test(
      cleaned,
    )
  ) {
    return "";
  }

  return limitTitleChars(cleaned, max);
}

/** 首条问题开头的寒暄 / 请求语，重复几次以处理「请帮我…」这类叠加 */
const LEADING_FILLER =
  /^(?:请帮我|请你|请问|请|麻烦你|麻烦|帮忙|帮我|我想|我需要|我要|能不能|可不可以|能否|可以|你可以|你帮我|给我)[\s，,、:：]*/;

/**
 * 本地兜底标题：不调用模型，把问题压成一句不超过 max 字的短句。
 *
 * 只用于模型返回前的临时展示与模型失败时的兜底，不做语义改写；
 * 目的不是「完美总结」，而是别让侧栏直接显示整段原始问题。
 */
export function condenseSessionTitle(
  source: string,
  max = SESSION_TITLE_MAX_CHARS,
): string {
  let text = source
    .replace(/\r\n?/g, "\n")
    // 代码块整体略去：标题里放代码没有意义
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[\s#>*+-]+/, "");
  text = collapseSpaces(text);

  // 去掉开头的寒暄 / 请求语，最多处理三次（可能叠加「麻烦你请帮我」）
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEADING_FILLER, "").trim();
    if (next === text) break;
    text = next;
  }
  text = text.replace(/一下/g, "").trim();
  if (!text) return "";

  // 只保留第一句；多行粘贴时不会把整段内容带进标题
  const sentenceEnd = text.search(/[。！？!?\n]/);
  if (sentenceEnd >= 0) text = text.slice(0, sentenceEnd).trim();
  text = text.replace(TRAILING_PUNCTUATION, "").trim();
  if (!text) return "";

  return limitTitleChars(text, max);
}

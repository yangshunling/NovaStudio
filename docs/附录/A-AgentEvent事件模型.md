# 附录 A — AgentEvent 事件模型

## 1. 为什么需要统一事件模型

不同 Agent CLI 的输出协议不同，但宿主（聊天、任务中心、工作流运行记录）需要统一的渲染模型。

`AgentEvent` 就是这层归一化：

- provider 负责把自家协议解码成事件；
- 宿主只消费 `type` 与通用字段；
- 渲染层不出现任何具体 CLI 的工具名；
- 内存流式、数据库落库、历史回放使用同一套合并规则。

---

## 2. 类型定义

文件：`src/shared/types.ts`

```ts
export type ToolKind = "read" | "write" | "exec" | "search" | "other";

export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_call";
      callId?: string;
      name: string;
      input: unknown;
      kind: ToolKind;
      target: string;
    }
  | {
      type: "tool_result";
      callId?: string;
      name: string;
      output: string;
      isError?: boolean;
    }
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
  | { type: "done" }
  | { type: "message_end"; blocks: AgentEvent[] };
```

### 2.1 分类

| 类型 | 来源 | 是否进入消息内容 | 是否累积 |
|---|---|---|---|
| `thinking` | 完整思考块 | 是 | 是 |
| `text` | 完整正文块 | 是 | 是 |
| `thinking_delta` | 思考增量 | 是（转成 thinking） | 是 |
| `text_delta` | 正文增量 | 是（转成 text） | 是 |
| `tool_call` | 工具调用 | 是 | 是 |
| `tool_result` | 工具回执 | 是 | 否（直接追加） |
| `error` | 致命错误 | 是 | 否 |
| `warning` | 非致命提示 | 是 | 否 |
| `done` | 流结束复位 | 否 | 否 |
| `message_end` | 整轮权威块 | 是（替换累积） | 特殊 |

---

## 3. 合并规则

文件：`src/shared/agent-events.ts`

```ts
export function appendEvent(content: AgentEvent[], event: AgentEvent): AgentEvent[] {
  // 1. 整轮权威块：替换末尾连续的累积块
  if (event.type === "message_end") {
    let start = content.length;
    while (start > 0 && isAccumulatedBlock(content[start - 1])) start--;
    return [...content.slice(0, start), ...event.blocks];
  }

  // 2. 增量：追加到末尾同类型块
  if (event.type === "text_delta" || event.type === "thinking_delta") {
    const blockType = event.type === "text_delta" ? "text" : "thinking";
    const last = content[content.length - 1];
    if (last && last.type === blockType && "content" in last) {
      return [
        ...content.slice(0, -1),
        { type: blockType, content: last.content + event.delta },
      ];
    }
    return [...content, { type: blockType, content: event.delta }];
  }

  // 3. 完整块与其它事件：追加
  return [...content, event];
}

function isAccumulatedBlock(event: AgentEvent): boolean {
  return event.type === "thinking" || event.type === "text" || event.type === "tool_call";
}
```

### 3.1 逐条说明

#### `message_end`

- 从末尾向前扫描，跳过连续的 `thinking` / `text` / `tool_call`；
- 把这些累积块整段替换为 `event.blocks`；
- 保留更早的块与 `tool_result` / `error` / `warning`。

**为什么**：provider 可能先发增量 delta（打字机），再发权威完整块。如果不收敛，界面上会出现“delta 文本 + 完整文本”两份。

**为什么只替换末尾连续块**：中间夹着 `tool_result` 时，说明发生了执行边界，不能跨边界替换。

#### `text_delta` / `thinking_delta`

- 末尾是同类型块 → 追加到它的 `content`；
- 否则新建一个完整块。

**为什么不是“总是替换末尾”**：如果上一块是 tool_call 或另一种类型，增量应开启新块，而不是覆盖。

#### `text` / `thinking` 完整块

- 始终作为新块追加。

**为什么**：完整块代表一个独立段落；provider 只发完整块时，每次输出都是新的语义段落，替换末尾会丢内容。

#### `tool_call` / `tool_result` / `error` / `warning`

- 直接追加。

#### `done`

- 不进入消息内容；渲染层 `_onEvent` 收到后 flush 缓冲并复位 streaming，主进程也把它排除在 `assistantContent` 之外。

---

## 4. 不变量

1. **同一段内的增量最终会被 `message_end` 收敛**，不会重复。
2. **`tool_result` 不会被 `message_end` 替换**（它不在累积块集合里）。
3. **中间夹 `tool_result` 时，`message_end` 只替换它之后的累积块**。
4. **`done` 永远不出现在 `Message.content` 里**。
5. **`message_end.blocks` 里的块不会再被后续 `message_end` 重复追加**，因为下一次收敛会先移除它们。

---

## 5. 典型序列

### 5.1 纯文本流

```
text_delta "你"
text_delta "好"
message_end [text "你好"]
```

合并过程：

```
[] 
→ [text "你"]
→ [text "你好"]
→ message_end 替换末尾 text → [text "你好"]
```

最终只有一份。

### 5.2 思考 + 正文

```
thinking_delta "分析"
thinking_delta "一下"
text_delta "答案"
message_end [thinking "分析一下", text "答案"]
```

最终：

```
[thinking "分析一下", text "答案"]
```

`message_end` 从末尾跳过 `text`、`thinking`，替换为整个 blocks。

### 5.3 工具调用

```
text_delta "我来看文件"
message_end [text "我来看文件", tool_call{Read, path}]
tool_result{Read, output}
text_delta "文件内容是..."
message_end [text "文件内容是..."]
```

第一次 `message_end` 替换 text；`tool_result` 追加；第二次 `message_end` 只替换它之后的 text，保留 tool_call 与 tool_result。

### 5.4 并行工具 + 回执夹在中间

```
assistant block1: text "先读 A"
assistant block2: tool_call A
tool_result A
assistant block3: text "再读 B"
assistant block4: tool_call B
```

Claude 解析器在 `tool_result` 到达时清空 buffer。随后 block3 的 `message_end` 只带 `[text "再读 B"]`，不会把前面的 `text "先读 A"` 与 `tool_call A` 重复一遍。

---

## 6. 与渲染层的关系

### 6.1 聊天气泡

`AssistantMessageList` 把 `AgentEvent[]` 转成 assistant-ui part：

| 事件 | part |
|---|---|
| `thinking` | `reasoning` |
| `text` | `text` |
| `tool_call` | `tool-call` |
| `tool_result` | 配对到最近的同 callId / 同名未完成 tool-call |
| `error` | `data novaError` |
| `warning` | `data novaWarning` |
| `message_end` | 递归转换 `blocks` |

### 6.2 工具配对

- `tool_call.callId` 与 `tool_result.callId` 优先精确配对；
- 没有 callId 时按 `name` 配对；
- 旧版重复 call 的历史修复：先收集 `resultsByCall`，最后补齐未配对调用。

### 6.3 任务中心

复用 `MessageGroup`（`components/chat/MessageList.tsx`），按事件类型渲染，不依赖聊天 store。

---

## 7. 与工作流的关系

- 节点实时事件走 `workflow:run:agentEvent`，不落库；
- 运行结束后以 `messages` 表的完整事件流为准；
- `runRound` 从事件里取：
  - `text` → `texts`
  - `text_delta` → `deltas`
  - `error` → `runtimeError`
- 最终正文优先取 `AgentService` 返回的 `assistantText`（来自权威 `message_end`）。

---

## 8. 测试

`tests/agent-events.test.ts`：

- `text_delta` 追加到末尾同类型块；
- `thinking` 与 `text` 增量不会互相覆盖；
- `message_end` 替换末尾累积块，保留工具结果；
- 完整 `text` 块始终新建段落。

`tests/parse.test.ts`：

- 工具回执穿插在同一条 assistant 消息中时，不会重复累积块；
- Bash 等命令类工具同样进入消息流，正文既不重复也不丢失；
- 同一段内的增量仍由 `message_end` 收敛，不产生重复。

---

## 9. 复刻检查

- [ ] `AgentEvent` 类型与字段一致。
- [ ] `appendEvent` 区分增量 / 完整块 / 权威块。
- [ ] `message_end` 只替换末尾连续累积块。
- [ ] `tool_result` 不被替换。
- [ ] `done` 不进入消息内容。
- [ ] 渲染层按事件类型转 part，不认识具体工具名。
- [ ] 工具 call/result 按 callId 优先配对。
- [ ] 工作流最终正文优先取权威 `message_end` 文本。

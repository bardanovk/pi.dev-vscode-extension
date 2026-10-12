declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

// --- types ------------------------------------------------------------------

interface TextBlk { type: "text"; text: string }
interface ThinkBlk { type: "thinking"; text: string }
interface ToolBlk {
  type: "toolCall";
  id: string;
  name: string;
  argsText: string;
  status: "pending" | "running" | "ok" | "error";
  result?: string;
}
type Blk = TextBlk | ThinkBlk | ToolBlk;

interface ChatItem {
  kind: "user" | "assistant";
  text?: string; // user
  blocks: Blk[]; // assistant
  streaming: boolean;
  meta?: string; // model · tokens · cost
}

// --- state ------------------------------------------------------------------

let items: ChatItem[] = [];
let errors: string[] = [];
let isStreaming = false;
let modelName = "";
let renderQueued = false;

const $messages = document.getElementById("messages")!;
const $input = document.getElementById("input") as HTMLTextAreaElement;
const $send = document.getElementById("send") as HTMLButtonElement;
const $stop = document.getElementById("stop") as HTMLButtonElement;
const $model = document.getElementById("model")!;
const $workstate = document.getElementById("workstate")!;

// --- helpers ----------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tiny markdown subset: fenced code, inline code, bold/italic, headings, lists, links. */
function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  const withFences = src.replace(/```([\w+-]*)\r?\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    blocks.push(
      `<div class="codeblock">${lang ? `<div class="lang">${escapeHtml(lang)}</div>` : ""}<pre><code>${escapeHtml(
        code.replace(/\n$/, "")
      )}</code></pre></div>`
    );
    return `\x00B${blocks.length - 1}\x00`;
  });

  const lines = escapeHtml(withFences).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;

  const inline = (s: string): string =>
    s
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?![*])/g, "$1<em>$2</em>")
      .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<span class="link" data-href="$2">$1</span>');

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const ph = line.match(/^\x00B(\d+)\x00\s*$/);
    if (ph) {
      closeList();
      out.push(blocks[Number(ph[1])]);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        list = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

function fmtUsage(u: any): string {
  if (!u) return "";
  const parts: string[] = [];
  if (typeof u.totalTokens === "number" && u.totalTokens > 0) parts.push(`${u.totalTokens} tok`);
  if (u?.cost && typeof u.cost.total === "number" && u.cost.total > 0) {
    parts.push(`$${u.cost.total < 0.01 ? u.cost.total.toFixed(4) : u.cost.total.toFixed(2)}`);
  }
  return parts.join(" · ");
}

// --- event reconstruction -----------------------------------------------------

function currentItem(): ChatItem | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function findToolBlk(toolCallId: string): ToolBlk | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "assistant") continue;
    for (let j = it.blocks.length - 1; j >= 0; j--) {
      const b = it.blocks[j];
      if (b.type === "toolCall" && b.id === toolCallId) return b;
    }
  }
  return undefined;
}

function blocksFromContent(content: any): Blk[] {
  if (!Array.isArray(content)) return [];
  const blocks: Blk[] = [];
  for (const b of content) {
    if (b?.type === "text") blocks.push({ type: "text", text: b.text ?? "" });
    else if (b?.type === "thinking") blocks.push({ type: "thinking", text: b.thinking ?? "" });
    else if (b?.type === "toolCall")
      blocks.push({
        type: "toolCall",
        id: b.id,
        name: b.name,
        argsText: JSON.stringify(b.arguments ?? {}),
        status: "pending",
        result: undefined
      });
  }
  return blocks;
}

function applyToolResult(msg: any): void {
  const blk = findToolBlk(msg.toolCallId);
  const text = extractText(msg.content);
  if (blk) {
    blk.status = msg.isError ? "error" : "ok";
    blk.result = truncate(text, 6000);
  } else {
    // result for a call we did not track — show as plain assistant note
    items.push({
      kind: "assistant",
      blocks: [{ type: "text", text: text }],
      streaming: false,
      meta: `tool: ${msg.toolName}${msg.isError ? " (error)" : ""}`
    });
  }
}

function onMessageStart(msg: any): void {
  if (msg.role === "user") {
    items.push({ kind: "user", text: extractText(msg.content), blocks: [], streaming: false });
  } else if (msg.role === "assistant") {
    items.push({ kind: "assistant", blocks: blocksFromContent(msg.content), streaming: true });
  } else if (msg.role === "toolResult") {
    applyToolResult(msg);
  }
}

function onUpdate(ev: any): void {
  const it = currentItem();
  if (!it || it.kind !== "assistant") return;
  const e = ev.assistantMessageEvent;
  if (!e) return;
  const idx: number = e.contentIndex ?? 0;
  const ensure = (make: () => Blk): Blk => {
    while (it.blocks.length <= idx) it.blocks.push({ type: "text", text: "" });
    if (!it.blocks[idx] || it.blocks[idx].type !== make().type) it.blocks[idx] = make();
    return it.blocks[idx];
  };
  switch (e.type) {
    case "text_delta": {
      const b = ensure(() => ({ type: "text", text: "" })) as TextBlk;
      b.text += e.delta ?? "";
      break;
    }
    case "text_end": {
      while (it.blocks.length <= idx) it.blocks.push({ type: "text", text: "" });
      it.blocks[idx] = { type: "text", text: e.content ?? "" };
      break;
    }
    case "thinking_delta": {
      const b = ensure(() => ({ type: "thinking", text: "" })) as ThinkBlk;
      b.text += e.delta ?? "";
      break;
    }
    case "thinking_end": {
      while (it.blocks.length <= idx) it.blocks.push({ type: "text", text: "" });
      it.blocks[idx] = { type: "thinking", text: e.content ?? "" };
      break;
    }
    case "toolcall_start": {
      while (it.blocks.length <= idx) it.blocks.push({ type: "text", text: "" });
      it.blocks[idx] = { type: "toolCall", id: e.id, name: e.toolName, argsText: "", status: "pending" };
      break;
    }
    case "toolcall_delta": {
      const b = it.blocks[idx];
      if (b?.type === "toolCall") b.argsText += e.delta ?? "";
      break;
    }
    case "toolcall_end": {
      while (it.blocks.length <= idx) it.blocks.push({ type: "text", text: "" });
      const tc = e.toolCall ?? {};
      it.blocks[idx] = {
        type: "toolCall",
        id: tc.id ?? e.id,
        name: tc.name ?? e.toolName,
        argsText: JSON.stringify(tc.arguments ?? {}),
        status: "pending"
      };
      break;
    }
  }
}

function onMessageEnd(msg: any): void {
  if (msg.role === "toolResult") {
    applyToolResult(msg);
    return;
  }
  const it = currentItem();
  if (!it) return;
  if (msg.role === "user") {
    if (it.kind === "user" && it.streaming === false) it.text = extractText(msg.content);
    return;
  }
  if (msg.role !== "assistant" || it.kind !== "assistant") return;
  // authoritative replacement; keep tool results collected during the turn
  const old = it.blocks;
  it.blocks = blocksFromContent(msg.content);
  for (const b of it.blocks) {
    if (b.type !== "toolCall") continue;
    const prev = old.find((o) => o.type === "toolCall" && o.id === b.id) as ToolBlk | undefined;
    if (prev) {
      b.status = prev.status;
      b.result = prev.result;
    }
  }
  it.streaming = false;
  const u = fmtUsage(msg.usage);
  const m = msg.model ?? msg.responseModel;
  it.meta = [m, u].filter(Boolean).join(" · ");
}

function onEvent(ev: any): void {
  switch (ev?.type) {
    case "message_start":
      onMessageStart(ev.message);
      break;
    case "message_update":
      onUpdate(ev);
      break;
    case "message_end":
      onMessageEnd(ev.message);
      break;
    case "tool_execution_start": {
      const b = findToolBlk(ev.toolCallId);
      if (b) b.status = "running";
      break;
    }
    case "tool_execution_end": {
      const b = findToolBlk(ev.toolCallId);
      if (b) {
        b.status = ev.isError ? "error" : "ok";
        b.result = truncate(extractText(ev.result?.content), 6000);
      }
      break;
    }
    case "agent_settled":
      for (const it of items) it.streaming = false;
      break;
  }
  scheduleRender();
}

// --- rendering ---------------------------------------------------------------

function renderBlk(b: Blk): string {
  if (b.type === "text") {
    return renderMarkdown(b.text || (b.text === "" ? "" : ""));
  }
  if (b.type === "thinking") {
    if (!b.text) return "";
    return `<details class="thinking"><summary>thinking</summary><div class="body">${escapeHtml(b.text)}</div></details>`;
  }
  const argsOneLine = b.argsText.replace(/\s+/g, " ").slice(0, 160);
  const status = b.status;
  const result =
    b.result !== undefined
      ? `<div class="result-label">result</div><pre>${escapeHtml(b.result)}</pre>`
      : "";
  return `<details class="toolcall ${status}" ${status === "running" || status === "error" ? "open" : ""}>
  <summary><span class="dot"></span><span class="name">${escapeHtml(b.name)}</span><span class="args">${escapeHtml(argsOneLine)}</span></summary>
  <pre>args: ${escapeHtml(truncate(b.argsText, 2000))}</pre>
  ${result}
</details>`;
}

function render(): string {
  const parts: string[] = [];
  for (const e of errors) parts.push(`<div class="error-banner">${escapeHtml(e)}</div>`);
  for (const it of items) {
    if (it.kind === "user") {
      parts.push(
        `<div class="msg user"><div class="meta"><span>you</span></div><div class="bubble">${escapeHtml(
          it.text ?? ""
        )}</div></div>`
      );
    } else {
      const body = it.blocks.map(renderBlk).join("");
      const meta = it.meta ? `<span>${escapeHtml(it.meta)}</span>` : "";
      const cursor = it.streaming ? `<span class="working">▍</span>` : "";
      parts.push(
        `<div class="msg assistant${it.streaming ? " streaming" : ""}"><div class="meta"><span>pi</span>${meta}</div><div class="bubble">${body}${cursor}</div></div>`
      );
    }
  }
  if (items.length === 0 && errors.length === 0) {
    parts.push(
      `<div class="msg assistant"><div class="meta"><span>pi</span></div><div class="bubble"><p>Chat with <strong>pi</strong> here. It uses the workspace root as its working directory.</p></div></div>`
    );
  }
  return parts.join("");
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const nearBottom =
      $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 120;
    $messages.innerHTML = render();
    if (nearBottom) $messages.scrollTop = $messages.scrollHeight;
  });
}

function updateChrome(): void {
  $model.textContent = modelName || "";
  $model.className = modelName ? "link" : "";
  $workstate.textContent = isStreaming ? "working…" : "";
  $workstate.className = isStreaming ? "working" : "";
  $send.style.display = isStreaming ? "none" : "";
  $stop.style.display = isStreaming ? "" : "none";
}

// --- messages from the extension host ------------------------------------------

window.addEventListener("message", (ev: MessageEvent) => {
  const m: any = ev.data;
  switch (m?.type) {
    case "init": {
      items = [];
      errors = [];
      for (const msg of m.messages ?? []) {
        if (msg?.role === "user") {
          items.push({ kind: "user", text: extractText(msg.content), blocks: [], streaming: false });
        } else if (msg?.role === "assistant") {
          const it: ChatItem = { kind: "assistant", blocks: blocksFromContent(msg.content), streaming: false };
          const u = fmtUsage(msg.usage);
          const mo = msg.model ?? msg.responseModel;
          it.meta = [mo, u].filter(Boolean).join(" · ");
          items.push(it);
        } else if (msg?.role === "toolResult") {
          applyToolResult(msg);
        }
      }
      modelName = m.state?.modelName ?? "";
      isStreaming = !!m.state?.isStreaming;
      updateChrome();
      scheduleRender();
      break;
    }
    case "status":
      modelName = m.state?.modelName ?? modelName;
      isStreaming = !!m.state?.isStreaming;
      updateChrome();
      break;
    case "event":
      onEvent(m.event);
      break;
    case "error":
      errors.push(String(m.message ?? "unknown error"));
      if (errors.length > 3) errors.shift();
      scheduleRender();
      break;
  }
});

// --- composer -------------------------------------------------------------------

function send(): void {
  const text = $input.value.trim();
  if (!text) return;
  $input.value = "";
  autosize();
  vscode.postMessage({ type: "prompt", text });
}

function autosize(): void {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 200) + "px";
}

$send.addEventListener("click", send);
$stop.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$input.addEventListener("input", autosize);
$model.addEventListener("click", () => vscode.postMessage({ type: "pickModel" }));
$messages.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const href = t.dataset?.href ?? t.parentElement?.dataset?.href;
  if (href) vscode.postMessage({ type: "openLink", href });
});

vscode.postMessage({ type: "ready" });

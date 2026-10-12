<div align="center">

<img src="media/logo-pi-dev.svg" width="220" alt="pi.dev for VS Code" />

# pi.dev — VS Code Extension

**[pi coding agent](https://github.com/earendil-works/pi) embedded in a native VS Code chat panel**

Runs `pi --mode rpc` as a subprocess and drives it over its JSONL protocol — no terminal required.

</div>

---

## ✨ Features

- 💬 **Chat panel** in the Activity Bar (π icon) with live token streaming
- 🧠 Collapsible **thinking blocks** and **tool call chips** with arguments & results
- ⌨️ `Enter` to send, `Shift+Enter` for a newline — messages typed during a run are **queued as follow-ups**
- ⏹️ **Stop** (queue drop + abort), **New Session**, and a **model picker** (QuickPick over `get_available_models`)
- 📝 Markdown rendering: fenced code blocks, lists, headings, links (opened via `vscode.env.openExternal`)
- 📊 Per-answer meta: model · tokens · cost
- 🔒 Hardened webview: strict CSP with nonce, HTML-escaped model output, LF-only RPC framing

## 🏗️ How it works

```
┌─────────────────────── Extension Development Host ───────────────────────┐
│                                                                          │
│  ┌── Webview (chat UI) ──┐    postMessage     ┌── extension.ts ────────┐ │
│  │ src/webview/main.ts   │ ◄────────────────► │  commands · state ·    │ │
│  │  event reconstruction │                    │  webview provider      │ │
│  │  markdown rendering   │                    │         │              │ │
│  └───────────────────────┘                    │         ▼              │ │
│                                               │  ┌── piRpc.ts ──────┐  │ │
│                                               │  │ JSONL over stdio │  │ │
│                                               │  └────────┬─────────┘  │ │
└────────────────────────────────────────────────┼──────────┼─────────────┘
                                                  ▼
                                       pi --mode rpc --no-session
                                        (cwd = workspace root)
```

The webview never talks to the agent directly: it reconstructs the conversation
from RPC session events (`message_start`, `message_update`, `message_end`,
`tool_execution_*`, `agent_settled`) exactly as defined in the
[pi RPC docs](https://github.com/earendil-works/pi).

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `pi.executablePath` | `pi` | pi CLI path (falls back to `~/.pi/agent/bin/pi` if not in `PATH`) |
| `pi.persistSessions` | `false` | persist sessions to disk (start pi without `--no-session`) |

## 🧰 Commands

| Command | Title |
|---|---|
| `piAgent.focus` | Pi: Open Pi Chat |
| `piAgent.newSession` | Pi: New Session |
| `piAgent.stop` | Pi: Stop current run |
| `piAgent.selectModel` | Pi: Select Model |

## 📦 Install

### From source

```bash
git clone git@github.com:bardanovk/pi.dev-vscode-extension.git
cd pi.dev-vscode-extension
npm install
npm run compile
```

Open the folder in VS Code and press **F5** — an Extension Development Host
starts with the π icon in the activity bar.

### Build a .vsix

```bash
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension pi-vscode-0.1.0.vsix
```

## 🛠️ Development

```bash
npm run compile    # esbuild bundle (extension + webview)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
```

### Project layout

```
src/
├── extension.ts        # activation, webview provider, commands, RPC wiring
├── piRpc.ts            # subprocess RPC client (LF framing, id correlation)
└── webview/main.ts     # chat UI: streaming reconstruction + rendering
media/                  # icons and logos
```

### Protocol notes

- **Framing**: one JSON object per LF-terminated line. `readline` is avoided —
  it also splits on U+2028/U+2029, which are valid inside JSON strings.
- **Idleness**: `agent_end` ≠ idle. Retries, compaction recovery and queued
  follow-ups may start another run; only `agent_settled` marks true idle.
- **Streaming prompts**: while a run is active, prompts must carry
  `streamingBehavior: "followUp"` (mirrors the TUI queue behavior).
- **Authoritative content**: streamed deltas are replaced by `message_end`
  payloads; tool results arrive as `toolResult`-role messages keyed by
  `toolCallId`.

## 📄 License

[MIT](LICENSE)

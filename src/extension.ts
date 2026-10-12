import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PiRpcClient } from "./piRpc";

export function activate(context: vscode.ExtensionContext): void {
  console.log("[pi-vscode] extension activated");
  const provider = new PiChatProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PiChatProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("piAgent.focus", () =>
      vscode.commands.executeCommand("piAgent.chat.focus")
    ),
    vscode.commands.registerCommand("piAgent.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("piAgent.stop", () => provider.stop()),
    vscode.commands.registerCommand("piAgent.selectModel", () => provider.selectModel())
  );
}

export function deactivate(): void {}

interface PiState {
  modelName?: string;
  isStreaming: boolean;
}

export class PiChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "piAgent.chat";

  private view?: vscode.WebviewView;
  private rpc?: PiRpcClient;
  private state: PiState = { isStreaming: false };

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m), undefined, this.context.subscriptions);
    view.onDidDispose(() => {
      this.rpc?.dispose();
      this.rpc = undefined;
    }, undefined, this.context.subscriptions);
  }

  // --- commands ------------------------------------------------------------

  async newSession(): Promise<void> {
    if (!this.ensureRpc()) return;
    try {
      await this.rpc!.request("new_session");
      await this.sync();
    } catch (e) {
      this.postError(e);
    }
  }

  async stop(): Promise<void> {
    if (!this.rpc) return;
    try {
      // Esc-like behavior: drop queued messages, then abort.
      await this.rpc.request("clear_queue");
      await this.rpc.request("abort");
    } catch (e) {
      this.postError(e);
    }
  }

  async selectModel(): Promise<void> {
    if (!this.ensureRpc()) return;
    try {
      const data = await this.rpc!.request("get_available_models");
      const models: any[] = data?.models ?? [];
      if (models.length === 0) {
        vscode.window.showInformationMessage("No configured models found.");
        return;
      }
      const current = this.state.modelName;
      const picks = models.map((m) => ({
        label: m.name ?? m.id,
        description: m.provider,
        detail: `${m.id} · ctx ${m.contextWindow ?? "?"}`,
        model: m,
        picked: (m.name ?? m.id) === current
      }));
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Select model" });
      if (!chosen) return;
      await this.rpc!.request("set_model", {
        provider: chosen.model.provider,
        modelId: chosen.model.id
      });
      await this.pushState();
    } catch (e) {
      this.postError(e);
    }
  }

  // --- rpc wiring ----------------------------------------------------------

  private ensureRpc(): boolean {
    if (this.rpc) return true;

    const cfg = vscode.workspace.getConfiguration("pi");
    let exe = cfg.get<string>("executablePath", "pi");
    if (exe === "pi") {
      // Desktop VS Code may lack the shell PATH; fall back to the default install location.
      const fallback = path.join(os.homedir(), ".pi", "agent", "bin", "pi");
      if (fs.existsSync(fallback)) exe = fallback;
    }
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.workspace.rootPath ?? process.cwd();
    const persist = cfg.get<boolean>("persistSessions", false);

    const rpc = new PiRpcClient(exe, cwd, persist);
    rpc.onEvent((ev) => this.onRpcEvent(ev));
    rpc.onExit((code, err) => {
      this.rpc = undefined;
      this.state.isStreaming = false;
      this.post({ type: "status", state: this.state });
      this.post({
        type: "error",
        message: err
          ? `Failed to start pi (${err.message}). Check the "pi.executablePath" setting.`
          : `pi process exited (code ${code}). Send a message to restart it.`
      });
    });
    rpc.start();
    this.rpc = rpc;
    return true;
  }

  private onRpcEvent(ev: any): void {
    // agent_end does NOT mean idle: retries, compaction recovery, steering,
    // or follow-ups can start another run. Only agent_settled marks true idle.
    if (ev?.type === "agent_start") {
      this.state.isStreaming = true;
      this.post({ type: "status", state: this.state });
    }
    if (ev?.type === "agent_settled") {
      this.state.isStreaming = false;
      this.post({ type: "status", state: this.state });
    }
    this.post({ type: "event", event: ev });
  }

  private async sync(): Promise<void> {
    if (!this.ensureRpc()) return;
    try {
      const [state, msgs] = await Promise.all([
        this.rpc!.request("get_state"),
        this.rpc!.request("get_messages")
      ]);
      this.state = {
        modelName: state?.model?.name ?? state?.model?.id,
        isStreaming: !!state?.isStreaming
      };
      this.post({
        type: "init",
        state: this.state,
        messages: msgs?.messages ?? []
      });
    } catch (e) {
      this.postError(e);
    }
  }

  private async pushState(): Promise<void> {
    if (!this.rpc) return;
    try {
      const state = await this.rpc.request("get_state");
      this.state.modelName = state?.model?.name ?? state?.model?.id;
      this.post({ type: "status", state: this.state });
    } catch {
      /* non-fatal */
    }
  }

  // --- webview plumbing ----------------------------------------------------

  private onWebviewMessage(m: any): void {
    switch (m?.type) {
      case "ready":
        void this.sync();
        break;
      case "prompt":
        if (!this.ensureRpc()) return;
        void this.rpc!.request("prompt", {
          message: m.text,
          // pi requires an explicit behavior when a run is already streaming;
          // followUp keeps parity with the TUI queue behavior.
          ...(this.state.isStreaming ? { streamingBehavior: "followUp" } : {})
        }).catch((e) => this.postError(e));
        break;
      case "abort":
        void this.stop();
        break;
      case "newSession":
        void this.newSession();
        break;
      case "pickModel":
        void this.selectModel();
        break;
      case "openLink": {
        const href = String(m.href ?? "");
        if (/^https:\/\//.test(href)) void vscode.env.openExternal(vscode.Uri.parse(href));
        break;
      }
    }
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private postError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.post({ type: "error", message });
  }

  // --- html ----------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2] || "0").join("");
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "main.js")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { --pi-accent: var(--vscode-focusBorder); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  #messages { flex: 1; overflow-y: auto; padding: 8px 12px; }
  .msg { margin: 10px 0; }
  .msg .meta {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground); margin-bottom: 2px;
    display: flex; gap: 8px; align-items: baseline;
  }
  .user .bubble, .assistant .bubble {
    padding: 8px 10px; border-radius: 6px; line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .user .bubble { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .assistant .bubble { background: color-mix(in srgb, var(--vscode-sideBar-background), var(--vscode-foreground) 4%); }
  .assistant.streaming .bubble { border-left: 2px solid var(--pi-accent); }
  .user .bubble { white-space: pre-wrap; }
  .bubble p { margin: 0 0 6px; } .bubble p:last-child { margin: 0; }
  .bubble h2, .bubble h3, .bubble h4 { margin: 8px 0 4px; }
  .bubble ul, .bubble ol { margin: 4px 0; padding-left: 20px; }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px; border-radius: 3px; font-size: 0.95em;
  }
  .codeblock { margin: 6px 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--vscode-panel-border, transparent); }
  .codeblock .lang {
    font-size: 10px; padding: 2px 8px; text-transform: lowercase;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-sideBar-background), var(--vscode-foreground) 6%);
  }
  .codeblock pre { margin: 0; padding: 8px; overflow-x: auto; }
  .codeblock pre code { background: none; padding: 0; font-size: 12px; line-height: 1.4; display: block; white-space: pre; }
  a, .link { color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: pointer; }
  details.thinking { margin: 4px 0; }
  details.thinking summary {
    cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  details.thinking .body {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    padding-left: 8px; margin-top: 4px; white-space: pre-wrap;
  }
  .toolcall {
    margin: 6px 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 6px; overflow: hidden; font-size: 12px;
  }
  .toolcall > summary {
    cursor: pointer; padding: 4px 8px; list-style: none;
    display: flex; align-items: center; gap: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background), var(--vscode-foreground) 5%);
  }
  .toolcall > summary::-webkit-details-marker { display: none; }
  .toolcall .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--vscode-descriptionForeground);
  }
  .toolcall.running .dot { background: var(--vscode-charts-yellow, #d7ba7d); animation: pulse 1s infinite alternate; }
  .toolcall.error .dot { background: var(--vscode-errorForeground, #f66); }
  .toolcall.ok .dot { background: var(--vscode-charts-green, #89d185); }
  @keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }
  .toolcall .name { font-family: var(--vscode-editor-font-family, monospace); }
  .toolcall .args {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
  }
  .toolcall pre {
    margin: 0; padding: 8px; max-height: 260px; overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px;
    white-space: pre-wrap;
  }
  .toolcall .result-label {
    font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 8px 0;
  }
  .error-banner {
    margin: 8px 0; padding: 6px 10px; border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-errorForeground, #f66) 12%, transparent);
    border: 1px solid var(--vscode-errorForeground, #f66);
    font-size: 12px; white-space: pre-wrap;
  }
  #statusline {
    padding: 2px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
    display: flex; justify-content: space-between; gap: 8px;
  }
  #statusline .working { color: var(--vscode-charts-yellow, #d7ba7d); }
  #composer {
    display: flex; gap: 6px; padding: 8px 12px 10px; align-items: flex-end;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  }
  #input {
    flex: 1; resize: none; min-height: 52px; max-height: 200px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 8px;
    outline: none;
  }
  #input:focus { border-color: var(--pi-accent); }
  #composer button {
    border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    font-size: 12px; white-space: nowrap;
  }
  #composer button:hover { background: var(--vscode-button-hoverBackground); }
  #composer button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  #stop { display: none; }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="statusline"><span id="model"></span><span id="workstate"></span></div>
  <div id="composer">
    <textarea id="input" placeholder="Ask pi… (Enter to send, Shift+Enter for a new line)" rows="2"></textarea>
    <button id="send" title="Send">Send</button>
    <button id="stop" class="secondary" title="Stop">Stop</button>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

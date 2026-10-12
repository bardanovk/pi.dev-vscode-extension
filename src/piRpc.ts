import { spawn, type ChildProcess } from "child_process";

/**
 * Minimal client for pi RPC mode.
 *
 * Protocol (see pi docs: rpc.md, rpc-commands.md, json.md):
 * - one JSON object per line (LF framing only; U+2028/U+2029 are NOT boundaries)
 * - commands go to stdin, each with an optional string `id`
 * - responses repeat the `id` and carry `success` + `data`/`error`
 * - everything else on stdout is a session event, forwarded to listeners
 */
export class PiRpcClient {
  private proc?: ChildProcess;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventCbs: ((e: any) => void)[] = [];
  private exitCbs: ((code: number | null, err?: Error) => void)[] = [];
  private started = false;
  private disposed = false;

  constructor(
    private readonly exe: string,
    private readonly cwd: string,
    private readonly persistSessions: boolean
  ) {}

  onEvent(cb: (e: any) => void): void {
    this.eventCbs.push(cb);
  }

  onExit(cb: (code: number | null, err?: Error) => void): void {
    this.exitCbs.push(cb);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    const args = ["--mode", "rpc"];
    if (!this.persistSessions) args.push("--no-session");

    const proc = spawn(this.exe, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onChunk(chunk));

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (c: string) => {
      const line = c.trim();
      if (line) console.warn("[pi stderr]", line.slice(0, 500));
    });

    proc.on("error", (err: Error) => {
      this.failPending(err);
      for (const cb of this.exitCbs) cb(null, err);
    });

    proc.on("exit", (code) => {
      this.proc = undefined;
      this.failPending(new Error(`pi process exited (code ${code})`));
      for (const cb of this.exitCbs) cb(code);
    });
  }

  /** Send a command and resolve with its response `data`. */
  request(type: string, extra?: Record<string, unknown>): Promise<any> {
    const id = `vscode-${++this.seq}`;
    const payload = JSON.stringify({ id, type, ...extra });
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (this.disposed || !stdin?.writable) {
        reject(new Error("pi process is not running"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      stdin.write(payload + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    try {
      proc.stdin?.end(); // orderly shutdown
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) proc.kill();
    }, 3000).unref();
    this.failPending(new Error("pi rpc client disposed"));
  }

  // --- internals -----------------------------------------------------------

  /** Strict LF-only framing: readline is NOT safe here (U+2028/U+2029). */
  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (line.trim().length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec && rec.type === "response") {
      const p = rec.id ? this.pending.get(rec.id) : undefined;
      if (p) {
        this.pending.delete(rec.id);
        if (rec.success) p.resolve(rec.data);
        else p.reject(new Error(rec.error || `command failed: ${rec.command}`));
      }
      return;
    }
    // session events and extension UI records
    for (const cb of this.eventCbs) {
      try {
        cb(rec);
      } catch (e) {
        console.error("[pi rpc] event listener failed", e);
      }
    }
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

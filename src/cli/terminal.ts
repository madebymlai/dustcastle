import type { ReadStream, WriteStream } from "node:tty";

export type KeyHandler = (key: string) => void;

export interface Terminal {
  readonly isTTY: boolean;
  readonly rows: number;
  write(s: string): void;
  error(s: string): void;
  onKey(handler: KeyHandler): () => void;
}

export type SelectIo = Pick<Terminal, "rows" | "write" | "onKey">;

export class ProcessTerminal implements Terminal {
  constructor(
    private readonly stdin: ReadStream = process.stdin,
    private readonly stdout: WriteStream = process.stdout,
    private readonly stderr: NodeJS.WriteStream = process.stderr,
  ) {}

  get isTTY(): boolean {
    return this.stdin.isTTY === true && this.stdout.isTTY === true;
  }

  get rows(): number {
    if (typeof this.stdout.rows !== "number") {
      throw new Error("terminal rows are unavailable because stdout is not a TTY");
    }
    return this.stdout.rows;
  }

  write(s: string): void {
    this.stdout.write(s);
  }

  error(s: string): void {
    this.stderr.write(s);
  }

  onKey(handler: KeyHandler): () => void {
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.setEncoding("utf8");

    const onData = (chunk: string | Buffer): void => {
      handler(String(chunk));
    };
    this.stdin.on("data", onData);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.stdin.removeListener("data", onData);
      this.stdin.setRawMode(false);
      this.stdin.pause();
    };
  }
}

export function processTerminal(): Terminal {
  return new ProcessTerminal();
}

export class InMemoryTerminal implements Terminal {
  isTTY: boolean;
  rows: number;
  private readonly keyHandlers = new Set<KeyHandler>();
  private writes = "";
  private errors = "";

  constructor(opts: { rows?: number; isTTY?: boolean } = {}) {
    this.rows = opts.rows ?? 24;
    this.isTTY = opts.isTTY ?? true;
  }

  get output(): string {
    return this.writes;
  }

  get errorOutput(): string {
    return this.errors;
  }

  write(s: string): void {
    this.writes += s;
  }

  error(s: string): void {
    this.errors += s;
  }

  onKey(handler: KeyHandler): () => void {
    this.keyHandlers.add(handler);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.keyHandlers.delete(handler);
    };
  }

  feed(key: string): void {
    for (const handler of [...this.keyHandlers]) handler(key);
  }
}

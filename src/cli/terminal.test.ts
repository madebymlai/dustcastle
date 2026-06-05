import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { ProcessTerminal } from "./terminal.js";

function fakeStdin(isTTY: boolean): ReadStream {
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    resume: () => void;
    pause: () => void;
    setEncoding: (encoding: BufferEncoding) => void;
  };
  stdin.isTTY = isTTY;
  stdin.setRawMode = vi.fn();
  stdin.resume = vi.fn();
  stdin.pause = vi.fn();
  stdin.setEncoding = vi.fn();
  return stdin as unknown as ReadStream;
}

function fakeStdout(isTTY: boolean, rows = 24): WriteStream {
  return { isTTY, rows, write: vi.fn() } as unknown as WriteStream;
}

describe("ProcessTerminal", () => {
  it("is fully interactive only when both stdin and stdout are TTYs", () => {
    expect(new ProcessTerminal(fakeStdin(true), fakeStdout(true)).isTTY).toBe(true);
    expect(new ProcessTerminal(fakeStdin(false), fakeStdout(true)).isTTY).toBe(false);
    expect(new ProcessTerminal(fakeStdin(true), fakeStdout(false)).isTTY).toBe(false);
  });

  it("owns raw-mode setup and teardown inside the key subscription", () => {
    const stdin = fakeStdin(true);
    const term = new ProcessTerminal(stdin, fakeStdout(true));
    const keys: string[] = [];

    const dispose = term.onKey((key) => keys.push(key));
    stdin.emit("data", "a");
    dispose();
    stdin.emit("data", "b");

    expect(keys).toEqual(["a"]);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.resume).toHaveBeenCalledOnce();
    expect(stdin.setEncoding).toHaveBeenCalledWith("utf8");
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(stdin.pause).toHaveBeenCalledOnce();
  });
});

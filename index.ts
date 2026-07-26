/**
 * Offline WhisperX dictation for pi.
 * alt+m starts/stops recording; alt+n cancels.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Readable } from "node:stream";

const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (message: string) => {
  if (DEBUG) appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${message}\n`);
};

// A local systemd user service keeps the WhisperX model warm in GPU memory.
const WHISPERX_SERVER = "http://127.0.0.1:8765";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const METER_CELLS = 6;
const METER_MIN_DB = -60;
const METER_MAX_DB = 0;

type State = "idle" | "recording" | "transcribing";
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

function rmsFromPcm16(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  let squares = 0;
  for (let i = 0; i < samples * 2; i += 2) {
    const sample = buf.readInt16LE(i);
    squares += sample * sample;
  }
  return Math.sqrt(squares / samples) / 32768;
}

function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const position = Math.max(
    0,
    Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)),
  );
  return PEAK_BLOCKS[Math.floor(position * (PEAK_BLOCKS.length - 1))]!;
}

/** Wrap signed 16-bit little-endian mono PCM in a minimal WAV container. */
function pcm16ToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let recorder: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let request: AbortController | null = null;
  let activeCtx: ExtensionContext | null = null;
  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;
  let generation = 0;
  let chunks: Buffer[] = [];
  let meterTimer: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let level = 0;
  let meterRemainder: Buffer = Buffer.alloc(0);

  const setStatus = (text: string | undefined) => activeCtx?.ui.setStatus("dictate", text);
  const stopMeter = () => {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
  };
  const stopSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = null;
  };
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    level = 0;
    meterRemainder = Buffer.alloc(0);
    const render = () => {
      const bars = meter.map(rmsToBlock).join("");
      setStatus(activeCtx?.ui.theme.fg("thinkingMedium", bars) ?? bars);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(level);
      render();
    }, 60);
  };
  const startSpinner = (suffix: string) => {
    stopSpinner();
    let frame = 0;
    const render = () => {
      const spinner = activeCtx?.ui.theme.fg("accent", SPINNER_FRAMES[frame]!) ?? SPINNER_FRAMES[frame]!;
      setStatus(`${spinner} ${suffix}`);
    };
    render();
    spinnerTimer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      render();
    }, 80);
  };

  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    const editor = asEditorLike(focused) ?? asEditorLike(focused?.editor);
    if (editor) return { kind: "editor", editor };
    if (typeof focused?.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const insert = (text: string) => {
    if (!activeCtx || !text) return;
    const target = tuiHandle ? resolveTarget() : null;
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      target.editor.setText(current + (current && !/\s$/.test(current) ? " " : "") + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      activeCtx.ui.setEditorText(current + (current && !/\s$/.test(current) ? " " : "") + text);
      return;
    }
    activeCtx.ui.notify("Dictation finished but no input field is focused", "warning");
  };

  const cleanup = () => {
    generation++;
    stopMeter();
    stopSpinner();
    try { recorder?.kill("SIGKILL"); } catch {}
    request?.abort();
    recorder = null;
    request = null;
    chunks = [];
    meterRemainder = Buffer.alloc(0);
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
  };

  const finish = (text?: string) => {
    if (text) insert(text);
    cleanup();
  };

  const transcribe = async (myGeneration: number, pcm: Buffer) => {
    if (myGeneration !== generation || state !== "transcribing") return;
    if (!pcm.length) {
      activeCtx?.ui.notify("No microphone audio captured", "warning");
      finish();
      return;
    }
    request = new AbortController();
    try {
      const response = await fetch(`${WHISPERX_SERVER}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: pcm16ToWav(pcm),
        signal: request.signal,
      });
      const result = await response.json() as { text?: string; error?: string };
      if (myGeneration !== generation) return;
      request = null;
      if (!response.ok) {
        activeCtx?.ui.notify(`Local WhisperX failed: ${result.error ?? response.statusText}`, "error");
        finish();
        return;
      }
      finish(result.text?.replace(/\s+/g, " ").trim());
    } catch (error: any) {
      if (myGeneration !== generation) return;
      activeCtx?.ui.notify(`Local WhisperX is unavailable: ${error.message}`, "error");
      finish();
    }
  };

  const startDictation = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    chunks = [];
    state = "recording";
    const myGeneration = ++generation;
    startMeter();
    try {
      // PipeWire provides the PulseAudio-compatible local source named "default".
      recorder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      ctx.ui.notify(`Could not start microphone capture: ${error.message}`, "error");
      cleanup();
      return;
    }
    const proc = recorder;
    proc.stdout.on("data", (chunk: Buffer) => {
      if (myGeneration !== generation) return;
      chunks.push(chunk);
      const meterChunk = meterRemainder.length ? Buffer.concat([meterRemainder, chunk]) : chunk;
      const alignedLength = meterChunk.length - (meterChunk.length % 2);
      meterRemainder = meterChunk.subarray(alignedLength);
      level = rmsFromPcm16(meterChunk.subarray(0, alignedLength));
    });
    proc.once("error", (error) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`Could not start ffmpeg microphone capture: ${error.message}`, "error");
      cleanup();
    });
    proc.once("close", (code) => {
      if (myGeneration !== generation || state !== "recording") return;
      if (code !== 0) {
        ctx.ui.notify("Microphone capture stopped unexpectedly", "error");
        cleanup();
      }
    });
    dbg(`recording started (generation ${myGeneration})`);
  };

  const stopDictation = () => {
    if (state !== "recording" || !recorder) return;
    state = "transcribing";
    stopMeter();
    startSpinner("transcribing locally…");
    const myGeneration = generation;
    const proc = recorder;
    proc.once("close", () => void transcribe(myGeneration, Buffer.concat(chunks)));
    try { proc.kill("SIGINT"); } catch { void transcribe(myGeneration, Buffer.concat(chunks)); }
  };

  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      stopDictation();
    }
  };

  const onGlobalInput = (data: string) => {
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.alt("m"))) {
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("n"))) {
      cleanup();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  pi.registerShortcut(Key.alt("m"), { description: "Toggle local WhisperX dictation", handler: async (ctx) => toggleDictation(ctx) });
  pi.registerShortcut(Key.alt("n"), { description: "Cancel local dictation", handler: async () => cleanup() });

  pi.registerCommand("tts", {
    description: "Control local WhisperX: /tts on, off, or status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        const result = await pi.exec("systemctl", ["--user", "start", "pi-dictate.service"], { timeout: 30_000 });
        ctx.ui.notify(result.code === 0 ? "Local WhisperX started" : `Could not start WhisperX: ${result.stderr}`, result.code === 0 ? "info" : "error");
        return;
      }
      if (action === "off") {
        cleanup();
        const result = await pi.exec("systemctl", ["--user", "stop", "pi-dictate.service"], { timeout: 30_000 });
        ctx.ui.notify(result.code === 0 ? "Local WhisperX stopped" : `Could not stop WhisperX: ${result.stderr}`, result.code === 0 ? "info" : "error");
        return;
      }
      if (action === "status") {
        const result = await pi.exec("systemctl", ["--user", "is-active", "--quiet", "pi-dictate.service"], { timeout: 5_000 });
        ctx.ui.notify(result.code === 0 ? "Local WhisperX is running" : "Local WhisperX is off", "info");
        return;
      }
      ctx.ui.notify("Usage: /tts on | off | status", "info");
    },
  });
  pi.on("session_shutdown", () => {
    cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });
}

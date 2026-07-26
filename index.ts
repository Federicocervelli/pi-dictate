/**
 * Offline Moonshine streaming dictation for pi.
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

// A local systemd user service keeps the CPU speech model warm.
const WHISPER_SERVER = "http://127.0.0.1:8765";
const STREAM_CHUNK_BYTES = 16_000; // 0.5 seconds of 16 kHz, mono, s16le PCM.

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

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let recorder: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let activeCtx: ExtensionContext | null = null;
  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;
  let generation = 0;
  let meterTimer: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let level = 0;
  let meterRemainder: Buffer = Buffer.alloc(0);
  let streamSession: string | null = null;
  let streamBuffer = Buffer.alloc(0);
  let streamQueue = Promise.resolve();
  let streamAbort: AbortController | null = null;
  let streamReady: Promise<void> | null = null;
  let serviceOwned = false;

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

  const stopOwnedServiceIfIdle = async () => {
    try {
      const response = await fetch(`${WHISPER_SERVER}/health`);
      const status = await response.json() as { active_sessions?: number };
      if (response.ok && status.active_sessions === 0) {
        await pi.exec("systemctl", ["--user", "stop", "pi-dictate.service"]);
      }
    } catch {}
  };

  const cleanup = () => {
    generation++;
    stopMeter();
    stopSpinner();
    try { recorder?.kill("SIGKILL"); } catch {}
    recorder = null;
    meterRemainder = Buffer.alloc(0);
    streamAbort?.abort();
    streamAbort = null;
    streamSession = null;
    streamBuffer = Buffer.alloc(0);
    streamQueue = Promise.resolve();
    streamReady = null;
    if (serviceOwned) {
      serviceOwned = false;
      void stopOwnedServiceIfIdle();
    }
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
  };

  const finish = (text?: string) => {
    if (text) insert(text);
    cleanup();
  };
  const ensureServerReady = async () => {
    const wasActive = await pi.exec("systemctl", ["--user", "is-active", "--quiet", "pi-dictate.service"], { timeout: 5_000 });
    serviceOwned = wasActive.code !== 0;
    const result = await pi.exec("systemctl", ["--user", "start", "pi-dictate.service"], { timeout: 30_000 });
    if (result.code !== 0) throw new Error(result.stderr || "could not start local dictation service");
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${WHISPER_SERVER}/health`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("local dictation service did not become ready");
  };

  const queueAvailableAudio = (session: string) => {
    while (streamBuffer.length >= STREAM_CHUNK_BYTES) {
      const audio = streamBuffer.subarray(0, STREAM_CHUNK_BYTES);
      streamBuffer = streamBuffer.subarray(STREAM_CHUNK_BYTES);
      sendStreamChunk(session, audio);
    }
  };

  const startStream = async (myGeneration: number) => {
    streamAbort = new AbortController();
    const response = await fetch(`${WHISPER_SERVER}/stream/start`, {
      method: "POST",
      signal: streamAbort.signal,
    });
    const result = await response.json() as { session?: string; error?: string };
    if (!response.ok || !result.session) throw new Error(result.error ?? response.statusText);
    if (myGeneration !== generation || state !== "recording") throw new Error("dictation cancelled");
    streamSession = result.session;
  };

  const sendStreamChunk = (session: string, chunk: Buffer) => {
    streamQueue = streamQueue.then(async () => {
      const response = await fetch(`${WHISPER_SERVER}/stream/audio?session=${session}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        signal: streamAbort?.signal,
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? response.statusText);
    });
  };

  const startDictation = async (ctx: ExtensionContext) => {
    activeCtx = ctx;
    state = "recording";
    const myGeneration = ++generation;
    streamBuffer = Buffer.alloc(0);
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
      const meterChunk = meterRemainder.length ? Buffer.concat([meterRemainder, chunk]) : chunk;
      const alignedLength = meterChunk.length - (meterChunk.length % 2);
      meterRemainder = meterChunk.subarray(alignedLength);
      level = rmsFromPcm16(meterChunk.subarray(0, alignedLength));
      streamBuffer = Buffer.concat([streamBuffer, chunk]);
      if (streamSession) queueAvailableAudio(streamSession);
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
    streamReady = (async () => {
      try {
        await ensureServerReady();
        await startStream(myGeneration);
        if (myGeneration !== generation || state !== "recording") {
          if (serviceOwned) {
            serviceOwned = false;
            await pi.exec("systemctl", ["--user", "stop", "pi-dictate.service"]);
          }
          return;
        }
        queueAvailableAudio(streamSession!);
      } catch (error: any) {
        if (myGeneration !== generation || state !== "recording") return;
        ctx.ui.notify(`Could not start local dictation: ${error.message}`, "error");
        cleanup();
      }
    })();
    dbg(`recording started (generation ${myGeneration})`);
  };

  const stopDictation = async () => {
    if (state !== "recording" || !recorder) return;
    state = "transcribing";
    stopMeter();
    startSpinner("transcribing locally…");
    const myGeneration = generation;
    const proc = recorder;
    const ready = streamReady;
    await new Promise<void>((resolve) => {
      proc.once("close", () => resolve());
      try { proc.kill("SIGINT"); } catch { resolve(); }
    });
    if (ready) await ready;
    if (myGeneration !== generation) return;
    if (!streamSession) {
      cleanup();
      return;
    }
    try {
      if (streamBuffer.length) {
        sendStreamChunk(streamSession, streamBuffer);
        streamBuffer = Buffer.alloc(0);
      }
      await streamQueue;
      const response = await fetch(`${WHISPER_SERVER}/stream/stop?session=${streamSession}`, {
        method: "POST",
        signal: streamAbort?.signal,
      });
      const result = await response.json() as { text?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? response.statusText);
      finish(result.text?.replace(/\s+/g, " ").trim());
    } catch (error: any) {
      if (myGeneration !== generation) return;
      activeCtx?.ui.notify(`Local streaming transcription failed: ${error.message}`, "error");
      cleanup();
    }
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
      void stopDictation();
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

  pi.registerShortcut(Key.alt("m"), { description: "Toggle local dictation", handler: async (ctx) => toggleDictation(ctx) });
  pi.registerShortcut(Key.alt("n"), { description: "Cancel local dictation", handler: async () => cleanup() });

  pi.registerCommand("tts", {
    description: "Control local dictation: /tts on, off, or status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        const result = await pi.exec("systemctl", ["--user", "start", "pi-dictate.service"], { timeout: 30_000 });
        ctx.ui.notify(result.code === 0 ? "Local dictation started" : `Could not start local dictation: ${result.stderr}`, result.code === 0 ? "info" : "error");
        return;
      }
      if (action === "off") {
        cleanup();
        const result = await pi.exec("systemctl", ["--user", "stop", "pi-dictate.service"], { timeout: 30_000 });
        ctx.ui.notify(result.code === 0 ? "Local dictation stopped" : `Could not stop local dictation: ${result.stderr}`, result.code === 0 ? "info" : "error");
        return;
      }
      if (action === "status") {
        const result = await pi.exec("systemctl", ["--user", "is-active", "--quiet", "pi-dictate.service"], { timeout: 5_000 });
        ctx.ui.notify(result.code === 0 ? "Local dictation is running" : "Local dictation is off", "info");
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

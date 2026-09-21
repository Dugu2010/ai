/**
 * Server-sent-events reader for the agent stream.
 *
 * The endpoint writes `event: <name>\ndata: <json>\n\n`. A malformed frame is
 * skipped rather than aborting the run, and frames are yielded in arrival order.
 */

export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

const MAX_LINE_BYTES = 1_048_576;

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    const name = event;
    const payload = dataLines.join("\n");
    event = "";
    dataLines = [];
    if (!name && !payload) return null;
    let parsed: Record<string, unknown> = {};
    if (payload) {
      try {
        const raw: unknown = JSON.parse(payload);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
      } catch {
        // A single bad frame must not end the chat run.
        return null;
      }
    }
    return { event: name, data: parsed };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LINE_BYTES) buffer = buffer.slice(-MAX_LINE_BYTES);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // `id:`, `retry:` and comments (`:…`) carry nothing we consume.
      }
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/* ---- Payload narrowing -----------------------------------------------------
 * Wire payloads are `unknown` at the edge. These helpers let call sites read a
 * field without `any` or a cast that lies about the shape.
 */

export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

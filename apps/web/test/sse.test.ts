import { describe, expect, it } from "vitest";
import { parseSseStream, type SseFrame } from "@/lib/sse";

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(chunks: Array<string | Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe("parseSseStream", () => {
  it("reads event/data pairs in arrival order", async () => {
    const frames = await collect(["event: activity\ndata: {\"seq\":1}\n\nevent: done\ndata: {\"seq\":2}\n\n"]);
    expect(frames.map((frame) => [frame.event, frame.data.seq])).toEqual([
      ["activity", 1],
      ["done", 2],
    ]);
  });

  it("reassembles a frame split across reads, including mid-JSON", async () => {
    const frames = await collect(["event: activity\nda", "ta: {\"seq\":1,", "\"state\":\"editing\"}\n", "\n"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toEqual({ seq: 1, state: "editing" });
  });

  it("tolerates CRLF line endings and a data line without its space", async () => {
    const frames = await collect(["event: activity\r\ndata:{\"seq\":3}\r\n\r\n"]);
    expect(frames[0]?.data.seq).toBe(3);
  });

  it("skips a malformed frame without ending the stream", async () => {
    const frames = await collect(["event: activity\ndata: {not json\n\n", "event: done\ndata: {\"ok\":true}\n\n"]);
    expect(frames.map((frame) => frame.event)).toEqual(["done"]);
  });

  it("yields a final frame that the stream closed without a blank line", async () => {
    const frames = await collect(["event: done\ndata: {\"seq\":9}\n"]);
    expect(frames[0]?.data.seq).toBe(9);
  });

  it("drops a line that grows past the cap across reads and resyncs afterwards", async () => {
    const half = "x".repeat(600_000);
    const frames = await collect([
      `event: activity\ndata: {"blob":"${half}`,
      half,
      `"}\n\n`,
      "event: done\ndata: {\"seq\":11}\n\n",
    ]);
    expect(frames.map((frame) => frame.event)).toEqual(["done"]);
    expect(frames[0]?.data.seq).toBe(11);
  });

  it("keeps every frame from a burst larger than the line cap in one read", async () => {
    // A timeline flush can arrive as many complete frames in a single chunk.
    // Trimming the buffer by total size threw the earliest of them away.
    const burst = Array.from(
      { length: 4_000 },
      (_, index) => `event: activity\ndata: {"seq":${index},"note":"${"y".repeat(300)}"}\n\n`
    ).join("");
    expect(burst.length).toBeGreaterThan(1_048_576);

    const frames = await collect([burst, "event: done\ndata: {\"seq\":4000}\n\n"]);
    expect(frames).toHaveLength(4_001);
    expect(frames[0]?.data.seq).toBe(0);
    expect(frames[3_999]?.data.seq).toBe(3_999);
    expect(frames[4_000]?.event).toBe("done");
  });
});

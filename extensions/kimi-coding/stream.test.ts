import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createKimiToolCallMarkupWrapper, wrapKimiProviderStream } from "./stream.js";

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

const KIMI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MULTI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_call_begin|> functions.write:1 <|tool_call_argument_begin|> {"file_path":"./out.txt","content":"done"} <|tool_call_end|> <|tool_calls_section_end|>';

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const finalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        { type: "text", text: KIMI_TOOL_TEXT },
      ],
      stopReason: "stop",
    };

    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [{ type: "message_end", partial, message }],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = (await stream.result()) as {
      content: unknown[];
      stopReason: string;
    };

    expect(events).toEqual([
      {
        type: "message_end",
        partial: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "normal response" }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("supports async stream functions", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = (await wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    )) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_MULTI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
        {
          type: "toolCall",
          id: "functions.write:1",
          name: "functions.write",
          arguments: { file_path: "./out.txt", content: "done" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("suppresses tagged tool-call text split across streaming events", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: " <|tool_calls_section" },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "_begin|> <|tool_call_begin|> functions.read:0 ",
          },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: '<|tool_call_argument_begin|> {"file_path":"./package.json"}',
          },
          { type: "text_end", contentIndex: 0, content: KIMI_TOOL_TEXT },
          { type: "message_end", message: finalMessage },
        ],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
  });

  it("replays normal text as soon as it cannot be a tagged tool call", async () => {
    const events = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hello" },
      { type: "text_end", contentIndex: 0, content: "Hello" },
    ];
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events,
        resultMessage: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const received: unknown[] = [];
    for await (const event of stream) {
      received.push(event);
    }
    expect(received).toEqual(events);
  });

  it("suppresses every stream event for multiple tagged tool calls", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_MULTI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [
          { type: "text_start", contentIndex: 2 },
          { type: "text_delta", contentIndex: 2, delta: KIMI_MULTI_TOOL_TEXT },
          { type: "text_end", contentIndex: 2, content: KIMI_MULTI_TOOL_TEXT },
          { type: "message_end", message: finalMessage },
        ],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const received: unknown[] = [];
    for await (const event of stream) {
      received.push(event);
    }
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain("<|tool_call");
  });

  it("does not leak a marker split before the argument marker", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: " <|tool_calls_section_begin|>" },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: " <|tool_call_begin|> functions.read:0 <|tool_call_arg",
          },
          {
            type: "text_delta",
            contentIndex: 0,
            delta:
              'ument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>',
          },
          { type: "text_end", contentIndex: 0, content: KIMI_TOOL_TEXT },
        ],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const received: unknown[] = [];
    for await (const event of stream) {
      received.push(event);
    }
    expect(received).toEqual([]);
  });

  it("adapts provider stream context without changing wrapper behavior", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });
});

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";

type KimiToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

function stripTaggedToolCallCounter(value: string): string {
  return value.trim().replace(/:\d+$/, "");
}

function parseKimiTaggedToolCalls(text: string): KimiToolCallBlock[] | null {
  const trimmed = text.trim();
  // Kimi emits tagged tool-call sections as standalone text blocks on this path.
  if (!trimmed.startsWith(TOOL_CALLS_SECTION_BEGIN) || !trimmed.endsWith(TOOL_CALLS_SECTION_END)) {
    return null;
  }

  let cursor = TOOL_CALLS_SECTION_BEGIN.length;
  const sectionEndIndex = trimmed.length - TOOL_CALLS_SECTION_END.length;
  const toolCalls: KimiToolCallBlock[] = [];

  while (cursor < sectionEndIndex) {
    while (cursor < sectionEndIndex && /\s/.test(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= sectionEndIndex) {
      break;
    }
    if (!trimmed.startsWith(TOOL_CALL_BEGIN, cursor)) {
      return null;
    }

    const nameStart = cursor + TOOL_CALL_BEGIN.length;
    const argMarkerIndex = trimmed.indexOf(TOOL_CALL_ARGUMENT_BEGIN, nameStart);
    if (argMarkerIndex < 0 || argMarkerIndex >= sectionEndIndex) {
      return null;
    }

    const rawId = trimmed.slice(nameStart, argMarkerIndex).trim();
    if (!rawId) {
      return null;
    }

    const argsStart = argMarkerIndex + TOOL_CALL_ARGUMENT_BEGIN.length;
    const callEndIndex = trimmed.indexOf(TOOL_CALL_END, argsStart);
    if (callEndIndex < 0 || callEndIndex > sectionEndIndex) {
      return null;
    }

    const rawArgs = trimmed.slice(argsStart, callEndIndex).trim();
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      return null;
    }
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      return null;
    }

    const name = stripTaggedToolCallCounter(rawId);
    if (!name) {
      return null;
    }

    toolCalls.push({
      type: "toolCall",
      id: rawId,
      name,
      arguments: parsedArgs as Record<string, unknown>,
    });

    cursor = callEndIndex + TOOL_CALL_END.length;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function rewriteKimiTaggedToolCallsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  let changed = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      nextContent.push(block);
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type !== "text" || typeof typedBlock.text !== "string") {
      nextContent.push(block);
      continue;
    }

    const parsed = parseKimiTaggedToolCalls(typedBlock.text);
    if (!parsed) {
      nextContent.push(block);
      continue;
    }

    nextContent.push(...parsed);
    changed = true;
  }

  if (!changed) {
    return;
  }

  (message as { content: unknown[] }).content = nextContent;
  const typedMessage = message as { stopReason?: unknown };
  if (typedMessage.stopReason === "stop") {
    typedMessage.stopReason = "toolUse";
  }
}

type BufferedTextEvents = {
  events: AssistantMessageEvent[];
  text: string;
};

function textContentIndex(event: { contentIndex?: unknown }): number {
  return typeof event.contentIndex === "number" && Number.isInteger(event.contentIndex)
    ? event.contentIndex
    : -1;
}

function couldBeKimiTaggedToolCall(text: string): boolean {
  const trimmedStart = text.trimStart();
  return (
    TOOL_CALLS_SECTION_BEGIN.startsWith(trimmedStart) ||
    trimmedStart.startsWith(TOOL_CALLS_SECTION_BEGIN)
  );
}

function wrapKimiTaggedToolCalls(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    rewriteKimiTaggedToolCallsInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      const bufferedTextEvents = new Map<number, BufferedTextEvents>();

      async function* wrappedIterator(): AsyncGenerator<AssistantMessageEvent> {
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            return;
          }

          const event = result.value;
          if (!event || typeof event !== "object") {
            yield event;
            continue;
          }

          const typedEvent = event as {
            type?: unknown;
            contentIndex?: unknown;
            delta?: unknown;
            content?: unknown;
            partial?: unknown;
            message?: unknown;
          };
          rewriteKimiTaggedToolCallsInMessage(typedEvent.partial);
          rewriteKimiTaggedToolCallsInMessage(typedEvent.message);

          const eventType = typedEvent.type;
          if (eventType === "text_start") {
            bufferedTextEvents.set(textContentIndex(typedEvent), { events: [event], text: "" });
            continue;
          }

          if (eventType === "text_delta" && typeof typedEvent.delta === "string") {
            const contentIndex = textContentIndex(typedEvent);
            const buffered = bufferedTextEvents.get(contentIndex) ?? { events: [], text: "" };
            buffered.events.push(event);
            buffered.text += typedEvent.delta;

            if (couldBeKimiTaggedToolCall(buffered.text)) {
              bufferedTextEvents.set(contentIndex, buffered);
              continue;
            }

            bufferedTextEvents.delete(contentIndex);
            yield* buffered.events;
            continue;
          }

          if (eventType === "text_end") {
            const contentIndex = textContentIndex(typedEvent);
            const buffered = bufferedTextEvents.get(contentIndex);
            const text =
              typeof typedEvent.content === "string" ? typedEvent.content : buffered?.text;
            bufferedTextEvents.delete(contentIndex);

            if (typeof text === "string" && parseKimiTaggedToolCalls(text)) {
              continue;
            }
            if (buffered) {
              yield* buffered.events;
            }
            yield event;
            continue;
          }

          yield event;
        }
      }

      return wrappedIterator();
    };

  return stream;
}

export function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => wrapKimiTaggedToolCalls(stream));
    }
    return wrapKimiTaggedToolCalls(maybeStream);
  };
}

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createKimiToolCallMarkupWrapper(ctx.streamFn);
}

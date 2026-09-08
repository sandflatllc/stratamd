import type { TerminalSnapshot as TerminalSessionSnapshot, TerminalEvent as TerminalAttachStreamEvent } from '../../shared/contracts'

/**
 * Retained terminal output as a list of chunks with their UTF-8 sizes. Each
 * output event appends one chunk and drops whole chunks from the front once
 * the byte budget is exceeded, so a busy terminal at capacity does no work
 * proportional to the whole retained buffer per event. The joined text is
 * only needed when a terminal surface is created or replaced.
 */
export interface TerminalBufferState {
  readonly chunks: readonly string[];
  readonly chunkBytes: readonly number[];
  readonly bytes: number;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  chunks: [],
  chunkBytes: [],
  bytes: 0,
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The retained output as one string, for writing into a fresh terminal surface. */
export function terminalBufferText(state: TerminalBufferState): string {
  return state.chunks.length === 1 ? state.chunks[0]! : state.chunks.join("");
}

function utf8Length(text: string): number {
  return textEncoder.encode(text).byteLength;
}

/** Keeps the last `maxBytes` UTF-8 bytes of one chunk, never starting inside a multibyte character. */
function tailOfChunk(chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoded = textEncoder.encode(chunk);
  if (encoded.byteLength <= maxBytes) {
    return chunk;
  }
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }
  return textDecoder.decode(encoded.subarray(start));
}

function bounded(chunks: string[], chunkBytes: number[], bytes: number, maxBytes: number): Pick<TerminalBufferState, "chunks" | "chunkBytes" | "bytes"> {
  if (maxBytes <= 0) {
    return { chunks: [], chunkBytes: [], bytes: 0 };
  }
  let start = 0;
  while (start < chunks.length - 1 && bytes - chunkBytes[start]! >= maxBytes) {
    bytes -= chunkBytes[start]!;
    start += 1;
  }
  if (start > 0) {
    chunks = chunks.slice(start);
    chunkBytes = chunkBytes.slice(start);
  }
  if (bytes > maxBytes) {
    const kept = tailOfChunk(chunks[0]!, chunkBytes[0]! - (bytes - maxBytes));
    const keptBytes = utf8Length(kept);
    bytes -= chunkBytes[0]! - keptBytes;
    chunks[0] = kept;
    chunkBytes[0] = keptBytes;
  }
  return { chunks, chunkBytes, bytes };
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  const history = tailOfChunk(snapshot.history, maxBufferBytes);
  return {
    chunks: history ? [history] : [],
    chunkBytes: history ? [utf8Length(history)] : [],
    bytes: history ? utf8Length(history) : 0,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output": {
      const added = utf8Length(event.data);
      return {
        ...current,
        ...bounded([...current.chunks, event.data], [...current.chunkBytes, added], current.bytes + added, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    }
    case "cleared":
      return {
        ...current,
        chunks: [],
        chunkBytes: [],
        bytes: 0,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

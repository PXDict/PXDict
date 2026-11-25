// Line-by-line NDJSON transform for proxied wuDict streams: each complete line is parsed, passed to
// `map`, and written out as soon as it arrives (no buffering of the whole response).

/** Returns the value to emit for one parsed line, or undefined to drop the line. */
export type NdjsonMapper = (value: unknown) => unknown;

/**
 * A TransformStream from NDJSON bytes to NDJSON bytes. Blank lines are dropped. A line that is not
 * valid JSON is dropped and reported through `onInvalid` (never echoed: it may hold file paths).
 */
export function ndjsonTransform(
  map: NdjsonMapper,
  onInvalid: (err: unknown) => void = () => undefined,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  const emit = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      onInvalid(err);
      return;
    }
    const out = map(value);
    if (out !== undefined) controller.enqueue(encoder.encode(JSON.stringify(out) + "\n"));
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        emit(buffered.slice(0, nl), controller);
        buffered = buffered.slice(nl + 1);
      }
    },
    flush(controller) {
      emit(buffered + decoder.decode(), controller);
      buffered = "";
    },
  });
}

/** Serialises values as an NDJSON body. */
export function ndjsonBody(values: unknown[]): string {
  return values.map((v) => JSON.stringify(v) + "\n").join("");
}

export const ndjsonContentType = "application/x-ndjson";

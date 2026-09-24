/**
 * Fully reads a Web ReadableStream into a Buffer. Used only for the
 * non-streaming fallback path (an upstream error response, typically a
 * small JSON body, returned instead of an actual SSE stream) — never for
 * the real streaming path, which forwards bytes as they arrive instead
 * of buffering the whole response.
 */
export async function bufferReadableStream(
  stream: ReadableStream<Uint8Array> | null,
): Promise<Buffer> {
  if (!stream) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

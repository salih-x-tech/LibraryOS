import "server-only";
import { ApplicationError } from "./errors";

// Bound streamed bytes, including requests without Content-Length.
export async function readBoundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApplicationError("BAD_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new ApplicationError("BAD_REQUEST"); }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new ApplicationError("BAD_REQUEST"); }
  finally { reader.releaseLock(); }
}

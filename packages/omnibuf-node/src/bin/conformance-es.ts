#!/usr/bin/env node
import {
  ConformanceRequestSchema,
  ConformanceResponseSchema,
  handleConformanceRequest,
  readFrames,
  writeFrame,
  type ConformanceRequest,
} from '../index.js';

/**
 * Standard OmniBuf Cross-Language Conformance Adapter for TypeScript / Node.js.
 * Reads 4-byte little-endian length-prefixed `ConformanceRequest` OmniBuf frames from `stdin`
 * and writes 4-byte little-endian length-prefixed `ConformanceResponse` OmniBuf frames to `stdout`.
 */
async function main(): Promise<void> {
  for await (const frame of readFrames(process.stdin)) {
    let req: ConformanceRequest;
    try {
      req = ConformanceRequestSchema.decode(frame);
    } catch (err) {
      const errResp = ConformanceResponseSchema.create({
        runtime_error: `unmarshal ConformanceRequest: ${err instanceof Error ? err.message : String(err)}`,
      });
      await writeFrame(process.stdout, ConformanceResponseSchema.encode(errResp));
      continue;
    }
    const resp = handleConformanceRequest(req);
    await writeFrame(process.stdout, ConformanceResponseSchema.encode(resp));
  }
}

main().catch((err) => {
  process.stderr.write(
    `conformance-es fatal error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});

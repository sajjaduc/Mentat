/**
 * Processing identity.
 *
 * ADR-0010: blob dedupe is not processing dedupe. Reusing a previous extraction is
 * only safe when the bytes *and* the full processing configuration agree, so the
 * pipeline keys runs by `contentHash + processorType + processorVersion +
 * configurationFingerprint`. A parser upgrade, a changed option or a new field
 * schema therefore re-processes the same bytes instead of surfacing stale results.
 *
 * The identity helpers live in their own module so both the pipeline and the job
 * handler can compute a key without importing the persistence layer.
 */
import { fingerprint } from '../../core/hash';

export interface ProcessingIdentity {
  contentHash: string;
  processorType: string;
  processorVersion: string;
  configurationFingerprint: string;
}

export function processingKeyFor(identity: ProcessingIdentity): string {
  return [
    identity.contentHash,
    identity.processorType,
    identity.processorVersion,
    identity.configurationFingerprint
  ].join(':');
}

/**
 * Fingerprint the processor identity plus any configuration that can change its
 * output (MIME overrides, size caps, extraction options). Default options are
 * folded in so a future option addition invalidates old runs.
 */
export async function configurationFingerprintFor(
  processor: { type: string; version: string },
  configuration: Record<string, unknown> = {}
): Promise<string> {
  return fingerprint({
    processorType: processor.type,
    processorVersion: processor.version,
    configuration
  });
}

import { Langfuse } from 'langfuse';
import { loadConfig } from '../config.js';
import { logger } from './logger.js';

let instance: Langfuse | null = null;

export interface TraceHandle {
  update: (data: Record<string, unknown>) => void;
  end: () => void;
}

/**
 * Get or create the singleton Langfuse client.
 * Returns null if credentials are not configured.
 */
export function getLangfuse(): Langfuse | null {
  if (instance) return instance;

  try {
    const config = loadConfig();
    if (!config.langfuseSecretKey || !config.langfusePublicKey) {
      logger.warn('Langfuse credentials not set; tracing disabled');
      return null;
    }

    instance = new Langfuse({
      secretKey: config.langfuseSecretKey,
      publicKey: config.langfusePublicKey,
      baseUrl: config.langfuseHost,
    });

    return instance;
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize Langfuse');
    return null;
  }
}

const noopHandle: TraceHandle = {
  update: () => {},
  end: () => {},
};

/**
 * Create a traced generation span. Falls back to a no-op if Langfuse is not available.
 */
export function traceGeneration(name: string, metadata?: Record<string, unknown>): TraceHandle {
  const lf = getLangfuse();
  if (!lf) return noopHandle;

  const trace = lf.trace({ name, metadata });
  return {
    update: (data: Record<string, unknown>) => {
      trace.update(data);
    },
    end: () => {
      // Langfuse traces auto-close; this is a semantic marker
    },
  };
}

/** Flush pending events. Call before process exit. */
export async function flushTraces(): Promise<void> {
  if (instance) {
    await instance.flushAsync();
  }
}

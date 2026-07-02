import { z } from 'zod';

const ConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  langfuseSecretKey: z.string().default(''),
  langfusePublicKey: z.string().default(''),
  langfuseHost: z.string().url().default('https://cloud.langfuse.com'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

/**
 * Load and validate configuration from environment variables.
 * Caches the result after the first call.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const result = ConfigSchema.safeParse({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
    langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
    langfuseHost: process.env.LANGFUSE_HOST,
  });

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${messages}`);
  }

  cached = result.data;
  return cached;
}

/** Reset cached config (useful in tests). */
export function resetConfig(): void {
  cached = null;
}

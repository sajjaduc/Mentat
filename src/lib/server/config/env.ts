/**
 * Runtime configuration.
 *
 * Mentat runs locally by default: SQLite file, local blob directory, no external
 * services. Every value can be overridden by an environment variable so the same
 * build runs in a container without code changes.
 *
 * The master key deserves special mention. Secrets are encrypted at rest with a
 * deployment-provided key. Rather than shipping a hard-coded development key
 * (which would be a real vulnerability), the resolver reads `MENTAT_MASTER_KEY`
 * when present and otherwise generates a random key once, stores it in
 * `data/master.key` with owner-only permissions, and logs a warning. That keeps a
 * fresh clone runnable without ever persisting secrets under a publicly known key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MENTAT_DB_PATH: z.string().default('./data/mentat.db'),
  MENTAT_MASTER_KEY: z.string().optional(),
  MENTAT_MASTER_KEY_PREVIOUS: z.string().optional(),
  MENTAT_BLOB_ROOT: z.string().default('./data/blobs'),
  MENTAT_DATA_DIR: z.string().default('./data'),
  MENTAT_BASE_URL: z.string().default('http://localhost:5273'),
  MENTAT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  MENTAT_WORKER_ENABLED: z.coerce.boolean().default(true),
  MENTAT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  MENTAT_WORKER_POLL_MS: z.coerce.number().int().min(25).default(500),
  MENTAT_JOB_LEASE_SECONDS: z.coerce.number().int().min(5).default(120),
  MENTAT_ALLOW_SIGNUP: z.coerce.boolean().default(true),
  MENTAT_SESSION_DAYS: z.coerce.number().int().min(1).default(30),
  MENTAT_COOKIE_SECURE: z.coerce.boolean().default(false),
  /** Ollama default endpoint offered in the provider setup form. */
  MENTAT_OLLAMA_URL: z.string().default('http://localhost:11434'),
  MENTAT_GCS_BUCKET: z.string().optional(),
  MENTAT_FILE_MAX_BYTES: z.coerce.number().int().min(1024).default(52_428_800),
  MENTAT_MIGRATIONS_DIR: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/** Reset the cached env — test-only helper. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}

export function isTest(): boolean {
  return env().NODE_ENV === 'test';
}

export function databasePath(): string {
  return env().MENTAT_DB_PATH;
}

export function blobRoot(): string {
  return path.resolve(env().MENTAT_BLOB_ROOT);
}

export function dataDir(): string {
  return path.resolve(env().MENTAT_DATA_DIR);
}

export function baseUrl(): string {
  return env().MENTAT_BASE_URL.replace(/\/+$/, '');
}

export function workerEnabled(): boolean {
  return env().MENTAT_WORKER_ENABLED;
}

const masterKeyPath = () => path.resolve(env().MENTAT_DATA_DIR, 'master.key');

/**
 * Resolve the master key used to encrypt secrets at rest.
 * Order: env var → previously generated local key → newly generated local key.
 */
export function resolveMasterKey(): string {
  const provided = env().MENTAT_MASTER_KEY;
  if (provided && provided.trim().length > 0) return provided;

  const keyPath = masterKeyPath();
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    // Not generated yet.
  }

  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  process.stderr.write(
    `[mentat] Generated a new master key at ${keyPath}. Back it up: secrets cannot be decrypted without it.\n`
  );
  return generated;
}

export function masterKeyVersion(): number {
  return 1;
}

export function allowSignup(): boolean {
  return env().MENTAT_ALLOW_SIGNUP;
}

export function fileMaxBytes(): number {
  const workspaceLimit = env().MENTAT_FILE_MAX_BYTES;
  return Number.isFinite(workspaceLimit) && workspaceLimit > 0 ? workspaceLimit : 52_428_800;
}

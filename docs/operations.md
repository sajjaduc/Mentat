# Operations

How to run, back up, rotate and troubleshoot a local Mentat instance. Everything
here assumes the single-node deployment this milestone targets: one process (or two:
server plus worker) against one SQLite file and one blob directory.

## Running

```bash
# Development: server with an in-process worker and hot reload.
bun run dev

# Production: build once, then run the built server.
bun run build
MENTAT_MASTER_KEY=... NODE_ENV=production bun run start

# Split roles: the server serves requests, a separate process works the queue.
MENTAT_WORKER_ENABLED=false bun run start
MENTAT_WORKER_ENABLED=false bun run worker --concurrency 8
```

Bootstrap runs on the first request and applies migrations automatically, so an
upgrade is: stop, deploy, start. The worker and server coordinate purely through
database leases, so a second worker process needs no configuration — but it *does*
need the same database path and the same master key.

### Health

`GET /api/health` reports whether the database opened, how many tables exist,
whether the master key came from the environment, and whether an in-process worker
is enabled. It is unauthenticated because it exposes no tenant data.

## Data on disk

| Path | Contents | Back up? |
| --- | --- | --- |
| `./data/mentat.db` (+ `-wal`, `-shm`) | All state: tickets, runs, audit, metadata | **Yes** |
| `./data/blobs/` | Raw file bytes, content-addressed | **Yes** (unless you use GCS) |
| `./data/master.key` | Generated secrets key | **Yes, separately** |
| `./data/` others | Local scratch | No |

Blobs are immutable once written: keys are SHA-256 hashes of content, so a file is
never modified in place. That makes incremental backup of `blobs/` safe, and it means
a restored blob store can never disagree with the database about content identity.

### Backup

The database is in WAL mode. Either stop the server, or use SQLite's online backup so
the copy is consistent:

```bash
bun -e "
  const {Database} = require('bun:sqlite');
  const db = new Database('./data/mentat.db', {readonly: true});
  db.exec(\"VACUUM INTO './backup/mentat-\" + Date.now() + \".db'\");
"
rsync -a --delete ./data/blobs/ ./backup/blobs/
cp ./data/master.key ./backup/master.key      # store this separately and securely
```

`VACUUM INTO` produces a single consistent file with no `-wal`/`-shm` sidecars, which
is the format you want to restore from.

### Restore

1. Stop Mentat.
2. Replace `./data/mentat.db` with the backup and remove any stale `-wal`/`-shm`.
3. Restore `./data/blobs/` (or point the workspace at the same GCS bucket).
4. Restore `./data/master.key` — without it, secrets cannot be decrypted. Rows stay
   intact but unusable; recreate them instead of guessing.
5. Start Mentat. Migrations apply on first request if the backup predates an upgrade.

### Retention

Nothing is deleted automatically except expired cache entries, expired sessions
(past 90 days), and consumed idempotency keys. Tickets, files, runs and audit rows
are retained indefinitely. Workspace `retentionDays` is stored in workspace settings
and is enforced by policy rather than by a background reaper, so a future retention
job can implement it without a schema change.

## Secrets and key rotation

Secrets use AES-256-GCM with a deployment master key. Each ciphertext records the key
version that produced it, so rotation is online:

1. Generate a new key: `openssl rand -base64 32`.
2. Set `MENTAT_MASTER_KEY_PREVIOUS` to the old key and
   `MENTAT_MASTER_KEY_PREVIOUS_VERSION` to the version it had.
3. Set `MENTAT_MASTER_KEY` to the new key and bump `MENTAT_MASTER_KEY_VERSION`.
4. Restart. New writes use the new key; existing rows stay readable.
5. Rotate each secret value through the UI (**Settings → Secrets → Rotate**) or
   `POST /api/secrets/:id/rotate`. That re-encrypts under the current key.
6. Once every secret has been rotated, remove the previous key variables.

Verify nothing is left behind by checking for old versions before dropping the key:

```sql
SELECT key_version, count(*) FROM secrets WHERE deleted_at IS NULL GROUP BY key_version;
```

A secret whose version no longer has a key in the keyring fails to decrypt with an
explicit error naming the version — it is never silently returned as blank.

## Worker behaviour

- **Leases.** A worker leases a job atomically and renews it while working. If the
  process dies, the lease expires and another worker (or the same one after restart)
  picks the job up. `maintenance.reap` also returns expired leases explicitly and
  records a `job.lease_expired` audit event.
- **Retries.** A failed job retries with exponential backoff and full jitter. Once
  attempts are exhausted it becomes `dead` (retryable but exhausted) or `failed`
  (not retryable). Both are visible in **Settings → Jobs**.
- **Agent-run retries.** A `state.enter` job's attempt budget comes from the state's
  `maxAttempts`. On the final failed attempt the ticket moves to the state's
  `failureStateId`, if configured, so a stuck ticket lands somewhere a human will see.
- **Idempotency.** Jobs carry a dedupe key for their unit of work and the payload
  includes the state-entry timestamp, so a stale job for a superseded entry is
  skipped rather than re-executed. Handlers are written to be safe to run twice.
- **Cron.** The scheduler claims due slots with a compare-and-swap on `nextRunAt`, so
  two schedulers cannot double-fire. It only enqueues durable jobs, never does work
  inline.

### Tuning

| Symptom | Adjustment |
| --- | --- |
| Long provider calls lose their lease | Raise `MENTAT_JOB_LEASE_SECONDS` (or the state's `timeoutSeconds` below it) |
| Queue drains slowly with many HTTP tools | Raise `MENTAT_WORKER_CONCURRENCY`; check the service's rate-limit concurrency |
| CPU idle between jobs | Lower `MENTAT_WORKER_POLL_MS` |
| Many `dead` jobs after a provider outage | Raise the job's `maxAttempts`, then re-dispatch affected tickets |

## Troubleshooting

**"MENTAT_MASTER_KEY must decode to 32 bytes"**
The key is not 32 bytes. Use `openssl rand -base64 32` or 64 hex characters.

**"Generated a new master key at ./data/master.key"**
Expected on first run without `MENTAT_MASTER_KEY`. Back the file up. If you see this
again after previously having secrets, you have lost the original key: existing
secrets cannot be decrypted, so recreate them.

**A ticket sits in an agent state and nothing happens**
Check, in order: the state has a bound agent (**Configuration → States**); the agent
has a model (**Agents → the agent**); the provider is healthy (**Models → Check
health**); the queue has a pending or dead `state.enter` job for that ticket
(**Settings → Jobs**); then open the ticket's **Agent Work** tab for the last run's
error.

**A run fails with `provider_error`**
Mentat already retried with backoff. Confirm the endpoint is reachable from the
server process, then check the model's configured capabilities — a tool-using agent
needs `toolCalling`.

**A transfer is refused**
Transfer policy, an unmet destination requirement, or an approval gate. The message
names the fields or the reason. `POST /api/tickets/:id/transfer-preview` explains
compatible, mapped, missing and source-only fields before you commit to the move.

**A file stays `pending`**
Its `file.process` job has not run or has failed. Check **Settings → Jobs**, then the
file's **Processing** tab for the processor error. Unsupported MIME types fail with an
explicit reason rather than producing empty content.

**Files are missing after a restore**
The database and `blobs/` were restored from different points in time. Bytes are
content-addressed and immutable, so re-uploading the affected files is safe and will
re-attach to the existing metadata.

**The UI feels stale**
Only live execution streams over SSE; lists refresh on navigation and after
mutations. If a run is streaming and nothing appears, check the browser's network
panel for `/api/events` — a proxy that buffers responses will break streaming
(`X-Accel-Buffering: no` is already sent).

## Security posture for a local instance

- Sessions are HttpOnly cookies; only the SHA-256 of a session token is stored.
- Passwords use Argon2id, and a missing account is verified against a dummy hash so
  response timing does not reveal existence.
- Cross-tenant reads return 404, never 403.
- Secret plaintext is registered with a process-wide redactor the moment it is
  decrypted, so logs, audit payloads, run snapshots and HTTP request logs cannot
  contain it even by accident.
- HTTP request logs store redacted headers and bodies; URL-encoded forms of a
  query-string key are masked too.
- Before exposing the instance beyond localhost: set `MENTAT_MASTER_KEY`, set
  `MENTAT_ALLOW_SIGNUP=false`, set `MENTAT_COOKIE_SECURE=true`, terminate TLS, and
  restrict network access to the port.

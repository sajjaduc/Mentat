/**
 * Test preload.
 *
 * Bun runs this before any test module, so environment defaults are in place
 * before `env()` is first resolved. Tests never touch the developer's real
 * database or blob directory.
 */
process.env.NODE_ENV = 'test';
process.env.MENTAT_LOG_LEVEL ??= 'error';
process.env.MENTAT_DB_PATH ??= ':memory:';
process.env.MENTAT_DATA_DIR ??= `${process.cwd()}/.test-data`;
process.env.MENTAT_BLOB_ROOT ??= `${process.cwd()}/.test-data/blobs`;
process.env.MENTAT_WORKER_ENABLED ??= 'false';
process.env.MENTAT_ALLOW_SIGNUP ??= 'true';
// Deterministic 32-byte key so secret tests are reproducible.
process.env.MENTAT_MASTER_KEY ??= '3ojl1YOUasRS3hPbFNEv+sWZIU9e3+BM/zw+mj6xczQ=';

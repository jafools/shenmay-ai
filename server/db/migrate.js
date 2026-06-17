/**
 * SHENMAY AI — Database Migration Runner
 * Runs SQL migrations in order, skipping already-applied ones.
 *
 * Concurrency + atomicity (audit M13 / task T12):
 *   - A session-level pg advisory lock serialises concurrent boots. Two
 *     containers (or a `migrate && server` race) starting at once → one runs the
 *     migrations, the other blocks on the lock, then sees everything already
 *     applied and does nothing. The applied-set is read AFTER taking the lock so
 *     the waiter observes the winner's freshly-committed rows.
 *   - Each migration's SQL and its schema_migrations INSERT run in ONE
 *     transaction, so a crash between them can't leave a migration applied-but-
 *     untracked. Previously those were two autocommitted statements: a crash in
 *     the gap re-ran an applied migration next boot, and safety rested entirely
 *     on hand-written idempotency (which already failed once, v3.5.0).
 *
 * Caveat: every migration must be transaction-safe. None today use
 * CREATE INDEX CONCURRENTLY / VACUUM / CREATE DATABASE. `ALTER TYPE ... ADD VALUE`
 * (migration 011) is allowed inside a transaction on PG 12+ as long as the new
 * value isn't used in the same transaction (it isn't). A future migration that
 * truly cannot run in a transaction would need a dedicated no-transaction path.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Arbitrary fixed key, unique to Shenmay's migration runner. Any boot that runs
// migrations takes this advisory lock first; a concurrent boot blocks here until
// the first finishes (then finds nothing to do).
const MIGRATION_LOCK_KEY = 4202026;

async function migrate() {
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
    console.error('ERROR: DATABASE_URL environment variable is required in production.');
    console.error('Set it in your .env or docker-compose file.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://shenmay:shenmay_dev_2026@localhost:5432/shenmay_ai',
  });

  // One dedicated connection holds the advisory lock for the whole run —
  // advisory locks are session-scoped, so every statement below uses this client.
  const client = await pool.connect();
  let locked = false;
  let failed = false;

  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    locked = true;

    // Create migration tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations (read AFTER taking the lock so a boot that
    // waited sees the other boot's freshly-committed migrations).
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));

    console.log('Running migrations...\n');

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  Skipping (already applied): ${file}`);
        continue;
      }

      console.log(`  Running: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      // SQL + tracker INSERT atomically: either both land or neither.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection may be dead */ });
        throw err;
      }
      console.log(`  ✓ Done: ${file}`);
      ran++;
    }

    if (ran === 0) {
      console.log('\nAll migrations already applied.');
    } else {
      console.log(`\n${ran} migration(s) applied successfully!`);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    failed = true;
  } finally {
    // Release the lock + connection cleanly before exiting. (Postgres also drops
    // the advisory lock automatically when the session ends, so a hard crash is
    // still safe — this is the tidy path.)
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {});
    }
    client.release();
    await pool.end();
  }

  if (failed) process.exit(1);
}

migrate();

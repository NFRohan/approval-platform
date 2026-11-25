// A local database for end-to-end checks: PGlite with every migration,
// one minted evaluation, and a socket for the app's pg driver.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// The repository root, wherever it is checked out.
export const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
export const USER = 'local.qa';
export const PASS = 'local-qa-password-1';

const scrypt = promisify(scryptCb);
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

export async function startLocalDb() {
  const db = new PGlite();
  for (const f of readdirSync(REPO + 'db').filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
    await db.exec(readFileSync(REPO + 'db/' + f, 'utf8'));
  }
  await db.exec(`select set_config('app.is_staff', 'true', false)`);
  const { rows } = await db.query(
    `select * from app.provision_demo($1, $2, $3, $4::interval)`,
    ['Local QA', USER, await hashPassword(PASS), '3 days'],
  );
  await db.exec(`select set_config('app.is_staff', 'false', false)`);
  const tenant = rows[0].tenant_id;

  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return { db, tenant, url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop: () => server.stop() };
}

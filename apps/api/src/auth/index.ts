import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, newId, nowIso, query } from '@api/db/index.js';
import { config } from '@platform/config.js';

const scrypt = promisify(scryptCallback);

interface UserRow {
  id: string;
  username: string;
  password_salt: string;
  password_hash: string;
  role: 'admin' | 'analyst';
  enabled: number;
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const value = await scrypt(password, salt, 64) as Buffer;
  return value.toString('hex');
}

export async function ensureBootstrapAdmin(): Promise<void> {
  if (!config.adminUsername || !config.adminPassword) return;
  if (config.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const existing = await query<UserRow>('SELECT * FROM users WHERE username = ?', [config.adminUsername]);
  if (existing[0]) return;
  const salt = randomBytes(16).toString('hex');
  await exec(
    `INSERT INTO users
     (id, username, password_salt, password_hash, role, enabled, created_at, last_login_at)
     VALUES (?, ?, ?, ?, 'admin', 1, ?, NULL)`,
    [newId(), config.adminUsername, salt, await passwordHash(config.adminPassword, salt), nowIso()]
  );
}

export async function login(username: string, password: string): Promise<string | null> {
  const rows = await query<UserRow>('SELECT * FROM users WHERE username = ? AND enabled = 1', [username]);
  const user = rows[0];
  if (!user) {
    await passwordHash(password, '00000000000000000000000000000000');
    return null;
  }
  const actual = Buffer.from(await passwordHash(password, user.password_salt));
  const expected = Buffer.from(user.password_hash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  await exec('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return issueSessionToken(user);
}

function issueSessionToken(user: UserRow): string {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id, username: user.username, role: user.role,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
  })).toString('base64url');
  const signature = createHmac('sha256', config.apiKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string): { sub: string; username: string; role: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', config.apiKey).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub: string; username: string; role: string; exp: number;
    };
    if (!parsed.sub || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

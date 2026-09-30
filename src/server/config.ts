import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AppConfig { host: string; port: number; dataDir: string; token: string; }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.ROOM_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ROOM_PORT must be 1..65535');
  const dataDir = resolve(env.ROOM_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, 'access-token.txt');
  let token = env.ROOM_ACCESS_TOKEN?.trim();
  if (!token) {
    if (existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf8').trim();
    else {
      token = randomBytes(32).toString('base64url');
      writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
    }
  }
  if (token.length < 32) throw new Error('Access token must contain at least 32 characters');
  return { host: env.ROOM_HOST ?? '0.0.0.0', port, dataDir, token };
}

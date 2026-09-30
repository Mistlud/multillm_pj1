import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Windows DPAPI binds encrypted credentials to the current Windows user.
// Base64 on stdin/stdout avoids PowerShell console encoding changing UTF-8 secrets.
export class CredentialStore {
  private dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, 'credentials'); mkdirSync(this.dir, { recursive: true }); }
  async save(secret: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Credential protection currently requires Windows DPAPI');
    if (secret.length > 100_000) throw new Error('Credential is too large');
    const id = randomUUID();
    const encrypted = await this.protect(secret, false);
    writeFileSync(join(this.dir, `${id}.dpapi`), encrypted, { mode: 0o600, flag: 'wx' });
    return id;
  }
  async read(id: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid credential reference');
    const path = join(this.dir, `${id}.dpapi`);
    if (!existsSync(path)) throw new Error('Credential not found');
    return this.protect(readFileSync(path, 'utf8'), true);
  }
  private async protect(value: string, decrypt: boolean): Promise<string> {
    const code = `Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($value); $result=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result));`;
    return new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, timeout: 10000, maxBuffer: 600000 }, (error, stdout) => {
        if (error) reject(new Error('Credential protection failed'));
        else resolve(decrypt ? Buffer.from(stdout, 'base64').toString('utf8') : stdout);
      });
      child.stdin?.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'));
    });
  }
}

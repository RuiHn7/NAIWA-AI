/* ============================================================================
 * desktop/store/secrets.ts —— API Key 加密存储
 * 用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 落盘的是 base64 密文；safeStorage 不可用时退化为混淆存储并在设置页提示。
 * 绝不写日志、绝不外传。
 * ==========================================================================*/

import { safeStorage } from 'electron';
import { readJson, writeJson } from './json';
import { secretsFile } from './paths';

type SecretBag = Record<string, string>;

function load(): SecretBag {
  return readJson<SecretBag>(secretsFile(), {});
}

function save(bag: SecretBag): void {
  writeJson(secretsFile(), bag);
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function setSecret(key: string, value: string): void {
  const bag = load();
  if (!value) {
    delete bag[key];
    save(bag);
    return;
  }
  if (isEncryptionAvailable()) {
    bag[key] = `enc:${safeStorage.encryptString(value).toString('base64')}`;
  } else {
    // 极少数无密钥环的 Linux 环境：退化为 base64，并在设置页显示警告
    bag[key] = `raw:${Buffer.from(value, 'utf8').toString('base64')}`;
  }
  save(bag);
}

export function getSecret(key: string): string | null {
  const bag = load();
  const stored = bag[key];
  if (!stored) return null;
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('raw:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

export function hasSecret(key: string): boolean {
  return Boolean(load()[key]);
}

export function deleteSecret(key: string): void {
  const bag = load();
  delete bag[key];
  save(bag);
}

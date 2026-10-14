import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { appConfigSchema, type ParsedAppConfig } from './schema.js';
import type { AppConfig } from '../model/types.js';

export class ConfigError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

/** 从 YAML 文本解析并校验配置；失败抛 ConfigError（含精确路径错误） */
export function parseConfigText(text: string): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`invalid YAML: ${(e as Error).message}`);
  }
  const parsed = appConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError('config validation failed', issues);
  }
  return parsed.data as AppConfig;
}

export function loadConfigFile(path: string): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file "${path}": ${(e as Error).message}`);
  }
  return parseConfigText(text);
}

export type { ParsedAppConfig };

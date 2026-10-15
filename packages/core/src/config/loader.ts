import { readFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * 读取配置文件。storage.path 的相对路径按「配置文件所在目录」解析为绝对路径：
 * 数据目录（db 及同级的 voices/、logs/）只跟配置文件走，与进程 cwd 无关，
 * 从任意目录启动看到的都是同一份数据。
 */
export function loadConfigFile(configPath: string): AppConfig {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file "${configPath}": ${(e as Error).message}`);
  }
  const cfg = parseConfigText(text);
  cfg.storage.path = path.resolve(path.dirname(path.resolve(configPath)), cfg.storage.path);
  return cfg;
}

export type { ParsedAppConfig };

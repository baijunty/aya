#!/usr/bin/env node
import { createApp } from './app.js';
import { logger } from './log.js';

function parseArgs(argv: string[]): { config: string } {
  let config = './config.yaml';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) config = argv[++i]!;
    else if (argv[i]?.startsWith('--config=')) config = argv[i]!.slice(9);
  }
  return { config };
}

const { config } = parseArgs(process.argv.slice(2));
const aya = createApp(config);

try {
  const url = await aya.listen();
  logger.info({ url, config }, 'Aya gateway started');
} catch (e) {
  logger.fatal({ err: e }, 'failed to start');
  process.exit(1);
}

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}`);
    await aya.shutdown().catch((e) => logger.error({ err: e }, 'shutdown error'));
    process.exit(0);
  });
}

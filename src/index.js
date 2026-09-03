import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSheetsClient } from './sheets.js';
import { createWhatsAppClient } from './whatsapp.js';
import { checkAll, fetchDetails } from './playstore.js';
import { runOnce } from './run.js';

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger({ verbose: config.dryRun });

  if (config.dryRun) {
    logger.info('DRY RUN: no messages will be sent and the sheet will not be written');
  }

  const sheets = createSheetsClient({
    serviceAccount: config.serviceAccount,
    sheetId: config.sheetId,
    sheetTab: config.sheetTab,
  });

  const whatsapp = config.dryRun
    ? { sendTemplate: async () => ({ ok: true, error: null }) }
    : createWhatsAppClient({
        token: config.metaToken,
        phoneNumberId: config.metaPhoneNumberId,
        apiVersion: config.metaApiVersion,
        templateLanguage: config.templateLanguage,
      });

  const { exitCode } = await runOnce({
    config,
    sheets,
    whatsapp,
    playstore: { checkAll, fetchDetails },
    logger,
    now: new Date(),
  });

  process.exitCode = exitCode;
}

main().catch((error) => {
  // Never print the error object wholesale; it can contain request bodies.
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});

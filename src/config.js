const DEFAULTS = {
  sheetTab: 'Apps',
  playRegion: 'US',
  concurrency: 20,
  metaApiVersion: 'v21.0',
  templateLanguage: 'en',
  templateAdded: 'play_store_app_added',
  templateRemoved: 'play_store_app_removed',
  canaryPackage: 'com.canary.doesnotexist.monitor',
};

function required(env, key) {
  const value = env[key];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return String(value).trim();
}

function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object');
  }
  if (!parsed.client_email) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email');
  }
  if (!parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing private_key');
  }
  return parsed;
}

function parseConcurrency(raw) {
  if (raw === undefined || raw === '') return DEFAULTS.concurrency;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('CONCURRENCY must be an integer between 1 and 100');
  }
  return value;
}

function parseRecipients(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const dryRun = String(env.DRY_RUN ?? '').toLowerCase() === 'true';

  const config = {
    dryRun,
    sheetId: required(env, 'SHEET_ID'),
    sheetTab: env.SHEET_TAB?.trim() || DEFAULTS.sheetTab,
    serviceAccount: parseServiceAccount(required(env, 'GOOGLE_SERVICE_ACCOUNT_JSON')),
    playRegion: env.PLAY_REGION?.trim() || DEFAULTS.playRegion,
    concurrency: parseConcurrency(env.CONCURRENCY),
    metaApiVersion: env.META_API_VERSION?.trim() || DEFAULTS.metaApiVersion,
    templateLanguage: env.TEMPLATE_LANGUAGE?.trim() || DEFAULTS.templateLanguage,
    templateAdded: env.TEMPLATE_ADDED?.trim() || DEFAULTS.templateAdded,
    templateRemoved: env.TEMPLATE_REMOVED?.trim() || DEFAULTS.templateRemoved,
    canaryPackage: env.CANARY_PACKAGE?.trim() || DEFAULTS.canaryPackage,
    metaToken: null,
    metaPhoneNumberId: null,
    recipients: [],
  };

  if (!dryRun) {
    config.metaToken = required(env, 'META_ACCESS_TOKEN');
    config.metaPhoneNumberId = required(env, 'META_PHONE_NUMBER_ID');
    config.recipients = parseRecipients(required(env, 'WHATSAPP_RECIPIENTS'));
    if (config.recipients.length === 0) {
      throw new Error('WHATSAPP_RECIPIENTS must contain at least one number');
    }
  }

  return config;
}

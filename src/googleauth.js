import { createSign } from 'node:crypto';

/**
 * Minimal Google service-account authentication.
 *
 * This replaces the `google-auth-library` dependency. The whole flow is a
 * signed JWT exchanged for an access token, which is about thirty lines, and
 * dropping the dependency removes the `npm install` step from CI entirely.
 * That matters here: the install took roughly three minutes of every run and
 * made a tight schedule impossible.
 *
 * See https://developers.google.com/identity/protocols/oauth2/service-account
 */

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_LIFETIME_SECONDS = 3600;

/** Refresh this long before expiry so a token never dies mid-run. */
const REFRESH_MARGIN_MS = 60_000;

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Builds the signed JWT that Google accepts in place of a password. */
export function buildAssertion({ serviceAccount, scope, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(serviceAccount.private_key);

  return `${signingInput}.${base64url(signature)}`;
}

export function createGoogleAuth({ serviceAccount, scope, fetchImpl = fetch }) {
  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;
  let cached = null;

  return {
    async getAccessToken(now = new Date()) {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now.getTime()) {
        return cached.token;
      }

      const response = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: GRANT_TYPE,
          assertion: buildAssertion({ serviceAccount, scope, now }),
        }).toString(),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Google token exchange failed ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = await response.json();
      if (!payload.access_token) {
        throw new Error('Google token exchange returned no access_token');
      }

      cached = {
        token: payload.access_token,
        expiresAt: now.getTime() + (payload.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000,
      };

      return cached.token;
    },
  };
}

export function buildTemplatePayload({ to, templateName, templateLanguage, params }) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  };
}

export function createWhatsAppClient({
  token,
  phoneNumberId,
  apiVersion,
  templateLanguage,
  fetchImpl = fetch,
}) {
  const endpoint = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  /** Redacts the access token so it can never reach a public Actions log. */
  const redact = (text) => String(text).split(token).join('[redacted]');

  return {
    async sendTemplate({ to, templateName, params }) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildTemplatePayload({ to, templateName, templateLanguage, params }),
          ),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return { ok: false, error: redact(`HTTP ${response.status}: ${body.slice(0, 300)}`) };
        }

        await response.json().catch(() => ({}));
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: redact(error.message ?? String(error)) };
      }
    },
  };
}

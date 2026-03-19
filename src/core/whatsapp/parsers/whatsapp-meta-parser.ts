export type MetaMessage = {
  from?: string;
  messageId?: string;
  type?: string;
  text?: string;
  buttonReply?: {
    id?: string;
    title?: string;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    address?: string;
    name?: string;
  };
  timestamp?: number;
};

/**
 * Extrae mensajes relevantes del payload del webhook de Meta WhatsApp.
 * Mantiene el parseo "puro" (sin dependencias externas) para facilitar tests.
 */
export function extractMessagesFromMeta(body: unknown): MetaMessage[] {
  if (!body || typeof body !== 'object') return [];

  // ── PASO 1: Utilidades de tipado seguro ─────────────────────────────────────
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const getString = (
    record: Record<string, unknown>,
    key: string,
  ): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  };

  const getOptionalNumber = (
    record: Record<string, unknown>,
    key: string,
  ): number | undefined => {
    const value = record[key];
    if (typeof value === 'number') return value;
    if (
      typeof value === 'string' &&
      value.trim() !== '' &&
      !Number.isNaN(Number(value))
    ) {
      return Number(value);
    }
    return undefined;
  };

  const getNumber = (
    record: Record<string, unknown>,
    key: string,
  ): number | undefined => {
    const value = record[key];
    if (typeof value === 'number') return value;
    if (
      typeof value === 'string' &&
      value.trim() !== '' &&
      !Number.isNaN(Number(value))
    ) {
      return Number(value);
    }
    return undefined;
  };

  // ── PASO 2: Recorrido del payload Meta ──────────────────────────────────────
  const root = body as Record<string, unknown>;
  const entries = root['entry'];
  if (!Array.isArray(entries)) return [];

  const result: MetaMessage[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = entry['changes'];
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!isRecord(change)) continue;

      // Nos aseguramos de quedarnos solo con eventos de tipo "messages"
      const field = getString(change, 'field');
      if (field && field !== 'messages') continue;

      const value = change['value'];
      if (!isRecord(value)) continue;

      const messages = value['messages'];
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        if (!isRecord(msg)) continue;

        const from = getString(msg, 'from');
        const messageId = getString(msg, 'id');
        const type = getString(msg, 'type');
        const timestamp = getNumber(msg, 'timestamp');

        // ── PASO 3: Extraer texto en formatos comunes ─────────────────────────
        const textFromText = isRecord(msg['text'])
          ? getString(msg['text'], 'body')
          : undefined;

        const interactive = msg['interactive'];
        const buttonReply =
          isRecord(interactive) && isRecord(interactive['button_reply'])
            ? {
                id: getString(interactive['button_reply'], 'id'),
                title: getString(interactive['button_reply'], 'title'),
              }
            : undefined;

        const textFromInteractiveButton = buttonReply?.title;

        const textFromInteractiveList =
          isRecord(interactive) && isRecord(interactive['list_reply'])
            ? getString(interactive['list_reply'], 'title')
            : undefined;

        const text =
          textFromText ??
          textFromInteractiveButton ??
          textFromInteractiveList;

        const locationObj = isRecord(msg['location']) ? msg['location'] : undefined;
        const location =
          type === 'location' && locationObj
            ? {
                latitude: getOptionalNumber(locationObj, 'latitude'),
                longitude: getOptionalNumber(locationObj, 'longitude'),
                address: getString(locationObj, 'address'),
                name: getString(locationObj, 'name'),
              }
            : undefined;

        result.push({
          from,
          messageId,
          type,
          text,
          buttonReply,
          location,
          timestamp,
        });
      }
    }
  }

  return result;
}


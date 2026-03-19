import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

// Archivo: `whatsapp-menu-scraper.service.ts`
// Propósito: precargar y cachear (TTL 30m) el mapeo `{ menu, sucursales, configuracion_carrito }`
// que el bot necesita para responder con el menú en WhatsApp, evitando descargas repetidas.

/**
 * Descarga y cachea el mapeo que usa el bot para armar el menú por WhatsApp.
 *
 * Por el posible bloqueo por "bot", evitamos recalcular/descargar en cada webhook:
 * - Se hace una precarga al iniciar el módulo.
 * - Se mantiene en memoria por TTL (30 minutos).
 * - Si hay múltiples requests concurrentes cuando expira, solo 1 descarga en vuelo.
 */
@Injectable()
export class WhatsAppMenuScraperService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppMenuScraperService.name);

  private cacheValue: WhatsAppMenuMapping | null = null;
  private cacheExpiresAtMs = 0;
  private inFlight: Promise<WhatsAppMenuMapping> | null = null;

  // ── CONFIG (puede parametrizarse vía env) ────────────────────────────────
  private readonly menuUrl =
    process.env.WHATSAPP_MENU_URL ??
    'https://pizzahut.com.bo/pages/whatsapp';

  private readonly cacheTtlMs =
    process.env.WHATSAPP_MENU_CACHE_TTL_MS
      ? Number(process.env.WHATSAPP_MENU_CACHE_TTL_MS)
      : 30 * 60 * 1000; // 30 minutos

  async onModuleInit() {
    // ── PASO 1: Precarga al arrancar ───────────────────────────────────────
    // Precarga no-bloqueante: si falla, igual el webhook seguirá operando.
    void this.getMenuMapping().catch((err) => {
      this.logger.warn(
        `No se pudo precargar el mapeo del menú: ${this.safeError(err)}`,
      );
    });
  }

  /**
   * Obtiene el mapeo del menú con cache en memoria.
   * Si no hay cache o está expirado, realiza descarga + parse.
   */
  async getMenuMapping(): Promise<WhatsAppMenuMapping> {
    // ── FASE 1: Validar cache vigente ─────────────────────────────────────
    const nowMs = Date.now();
    if (this.cacheValue && nowMs < this.cacheExpiresAtMs) {
      return this.cacheValue;
    }

    // ── FASE 2: Evitar "stampede" (descargas concurrentes) ─────────────
    if (this.inFlight) {
      return await this.inFlight;
    }

    // ── FASE 3: Descargar + parsear + cachear ─────────────────────────────
    this.inFlight = this.fetchAndParseMenuMapping()
      .then((value) => {
        this.cacheValue = value;
        this.cacheExpiresAtMs = Date.now() + this.cacheTtlMs;
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return await this.inFlight;
  }

  // ── FASE 1: Descarga del HTML y extracción del JSON embebido ─────────────
  private async fetchAndParseMenuMapping(): Promise<WhatsAppMenuMapping> {
    // ── FASE 1: Descarga del HTML / respuesta ─────────────────────────────
    const fetchFn = (globalThis as any).fetch as
      | undefined
      | ((...args: any[]) => Promise<any>);
    if (!fetchFn) {
      throw new Error('fetch no está disponible en este runtime');
    }

    const res = await fetchFn(this.menuUrl, {
      method: 'GET',
      headers: {
        // User-Agent simple para reducir chances de bloqueo básico.
        'User-Agent':
          'Mozilla/5.0 (compatible; pizza-hut-whatsapp-bot/1.0; +https://example.com)',
        Accept: 'text/html,application/xhtml+xml,application/json',
      },
    });

    if (!res || !res.ok) {
      const status = res?.status;
      throw new Error(
        `HTTP error al obtener menú: ${status ?? 'unknown'}`,
      );
    }

    const text = await res.text();

    // ── FASE 2: Parse del mapeo esperado ─────────────────────────────────
    const mapping = this.extractMappingFromResponseText(text);

    // ── FASE 3: Normalización de imágenes ────────────────────────────────
    // Normalizamos URLs de imágenes tipo "//..." a "https://..."
    for (const link of mapping.menu.links) {
      if (link.image?.startsWith('//')) link.image = `https:${link.image}`;
    }

    return mapping;
  }

  private extractMappingFromResponseText(
    text: string,
  ): WhatsAppMenuMapping {
    const trimmed = text.trim();

    // ── PASO 1: Si viene JSON directo, lo usamos como fuente ────────────
    // Caso 1: la URL devuelve JSON directo.
    if (trimmed.startsWith('{') && trimmed.includes('"menu"')) {
      const parsed = JSON.parse(trimmed) as WhatsAppMenuMapping;
      this.assertMappingShape(parsed);
      return parsed;
    }

    // ── PASO 2: Si viene HTML, extraemos el JSON embebido ───────────────
    // Caso 2: HTML con JSON embebido: extraemos el primer objeto JSON que
    // contenga las claves del payload esperado.
    const jsonObject = this.extractFirstJsonObject(text, [
      '"menu"',
      '"sucursales"',
      '"configuracion_carrito"',
    ]);
    const parsed = JSON.parse(jsonObject) as WhatsAppMenuMapping;

    this.assertMappingShape(parsed);
    return parsed;
  }

  /**
   * Extrae un objeto JSON del texto buscando la primera ocurrencia de un set
   * de "keys" y haciendo balance de llaves '{' '}'.
   */
  private extractFirstJsonObject(
    text: string,
    requiredKeys: string[],
  ): string {
    // ── PASO 1: Ubicar una clave guía dentro del HTML ─────────────────────
    const requiredKey = requiredKeys[0];
    const indexKey = text.indexOf(requiredKey);
    if (indexKey < 0) {
      throw new Error(
        `No se encontró la clave requerida en el HTML: ${requiredKey}`,
      );
    }

    // Buscamos hacia atrás el '{' que abre el objeto.
    const startIndex = text.lastIndexOf('{', indexKey);
    if (startIndex < 0) {
      throw new Error('No se encontró apertura "{" para el JSON embebido');
    }

    // ── PASO 2: Extraer un candidato completo por balance de llaves ────
    const jsonCandidate = this.extractJsonByBraceBalance(text, startIndex);

    // Validación superficial: que efectivamente tenga las otras keys.
    for (const k of requiredKeys.slice(1)) {
      if (!jsonCandidate.includes(k)) {
        throw new Error(
          `El JSON extraído no contiene la clave esperada: ${k}`,
        );
      }
    }

    return jsonCandidate;
  }

  private extractJsonByBraceBalance(text: string, startIndex: number) {
    // ── FASE 1: Recorrido carácter a carácter (ignorando strings) ──────
    let depth = 0;
    let inString = false;
    let stringQuote: '"' | '\'' | null = null;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (stringQuote && ch === stringQuote) {
          inString = false;
          stringQuote = null;
        }
        continue;
      }

      // Fuera de strings
      if (ch === '"' || ch === '\'') {
        inString = true;
        stringQuote = ch;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(startIndex, i + 1);
        }
      }
    }

    throw new Error('No se pudo extraer el JSON por balance de llaves');
  }

  private assertMappingShape(value: any): asserts value is WhatsAppMenuMapping {
    // ── PASO 1: Validación mínima (evita errores silenciosos en parse) ──
    if (!value || typeof value !== 'object') {
      throw new Error('Mapping inválido (no es objeto)');
    }

    if (!value.menu || !Array.isArray(value.menu.links)) {
      throw new Error('Mapping inválido: falta menu.links');
    }

    if (!Array.isArray(value.sucursales)) {
      throw new Error('Mapping inválido: falta sucursales');
    }

    if (
      !value.configuracion_carrito ||
      typeof value.configuracion_carrito !== 'object'
    ) {
      throw new Error('Mapping inválido: falta configuracion_carrito');
    }
  }

  private safeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
}

// Tipos (ligeros) para el payload esperado del sitio.
export type WhatsAppMenuMapping = {
  menu: {
    title: string;
    links: Array<{
      title: string;
      image: string;
    }>;
  };
  sucursales: Array<{
    id_publico: string;
    id: string;
    lat: number;
    lng: number;
    nombre: string;
    estado: boolean;
    servicios: string[];
    turnos: Array<{
      dias: number[];
      horaInicial: string;
      horaFinal: string;
    }>;
    telefono: string;
    backend: string;
    localizacion: string;
  }>;
  configuracion_carrito: {
    cantidad_minima: number;
    costo_envio_domicilio: number;
  };
};


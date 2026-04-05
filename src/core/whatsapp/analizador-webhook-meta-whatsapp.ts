/**
 * Extrae mensajes entrantes del JSON del webhook de WhatsApp de Meta.
 */

import { MensajeEntranteWhatsappNormalizado, TipoMensajeEntranteWhatsapp } from "./mensaje-entrante-whatsapp-normalizado";

// Forma mínima del body que envía Meta (solo lo que usamos)
interface CuerpoWebhookMeta {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string };
        contacts?: Array<{
          profile?: { name?: string };
          wa_id?: string;
        }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;

          type?: string;
          text?: { body?: string };

          // Cuando el usuario toca un boton de tipo interactive
          interactive?: { type?: string; button_reply?: { id?: string; title?: string; }; };

          // Cuando el usuario comparte ubicacion
          location?: { latitude?: number; longitude?: number; name?: string; address?: string; };
        }>;
      };
    }>;
  }>;
}

// Mapeo el string de tipo de Meta a nuestro (dominio)
function aTipoMensajeEntrante(raw: string | undefined): TipoMensajeEntranteWhatsapp {
  const t = raw ?? 'desconocido';
  const mapa: Record<string, TipoMensajeEntranteWhatsapp> = {
    text: 'texto',
    image: 'imagen',
    audio: 'audio',
    video: 'video',
    document: 'documento',
    sticker: 'sticker',
    location: 'ubicacion',
    contacts: 'contactos',
    interactive: 'interactivo',
    button: 'boton',
  };
  return mapa[t] ?? 'desconocido';
}

/**
 * Recorre entry/changes y devulve mensajes normalizados solo si coincide (metadata.phone_number_id)
 * Si Meta envia otro numero de negocio, se omite ese bloque para no mezclar lineas WABA
*/
export function extraerMensajesEntrantesNormalizados(
  cuerpo: unknown,
  idNumeroTelefonoEsperado: string,
): MensajeEntranteWhatsappNormalizado[] {
  if (typeof cuerpo !== 'object' || cuerpo === null) {
    return [];
  }

  const datos = cuerpo as CuerpoWebhookMeta;
  if (datos.object !== 'whatsapp_business_account') {
    return [];
  }

  const resultado: MensajeEntranteWhatsappNormalizado[] = [];

  for (const entrada of datos.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== 'messages') {
        continue;
      }
      const idTelefonoMeta = cambio.value?.metadata?.phone_number_id;
      if (!idTelefonoMeta) {
        continue;
      }
      if (idTelefonoMeta !== idNumeroTelefonoEsperado) {
        continue;
      }
      for (const m of cambio.value?.messages ?? []) {
        const idMsg = m.id;
        const desde = m.from;
        const ts = m.timestamp;
        if (!idMsg || !desde || !ts) {
          continue;
        }

        const tipo = aTipoMensajeEntrante(m.type);

        // PASO 1 : Extraer texto si corresponde
        const textoPlano = tipo === 'texto' ? m.text?.body : undefined;

        // PASO 2 : Extraer boton si corresponde (interactive/button reply)
        const idBotonRespuesta = tipo === 'interactivo' ? m.interactive?.button_reply?.id : undefined;
        const tituloBotonRespuesta = tipo === 'interactivo' ? m.interactive?.button_reply?.title : undefined;

        // PASO 3 : Extraer ubicacion si corresponde (location)
        const ubicacion = tipo === 'ubicacion' ? {
          latitude: m.location?.latitude ?? NaN,
          longitude: m.location?.longitude ?? NaN,
          direccion: m.location?.address,
          nombre: m.location?.name,
        } :undefined;

        // Validacion minima : si es ubicacion pero no hay lat/long, la ignoramos
        const ubicacionValida = ubicacion && Number.isFinite(ubicacion.latitude) && Number.isFinite(ubicacion.longitude) ? ubicacion : undefined;

        // PASO 4 : Si todo esta OK, agregar al resultado
        if(textoPlano || idBotonRespuesta || ubicacionValida){
          resultado.push({
            idMensajeWhatsapp: idMsg,
            numeroWhatsappOrigen: desde,
            marcaTiempo: ts,
            tipo,
            textoPlano,
            idBotonPresionado: idBotonRespuesta,
            tituloBotonRespuesta,
            ubicacion: ubicacionValida,
          });
        }
      }
    }
  }
  return resultado;
}

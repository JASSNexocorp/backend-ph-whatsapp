/**
 * Tipos de dominio para un mensaje entrante ya normalizado desde el webhook de Meta.
 * No depende de Nest ni de HTTP — solo describe qué necesita el flujo de compra.
 */
export type TipoMensajeEntranteWhatsapp =
  | 'texto'
  | 'imagen'
  | 'audio'
  | 'video'
  | 'documento'
  | 'sticker'
  | 'ubicacion'
  | 'contactos'
  | 'interactivo'
  | 'boton'
  | 'desconocido';

export interface MensajeEntranteWhatsappNormalizado {
    // ID unico del mensaje en META (sirve para idempotencia ante reintentos)
    idMensajeWhatsapp: string;

    // Numero del usuario tal como viene en el webhook (con +, espacios, etc)
    numeroWhatsappOrigen: string;

    // Timestamp en string (META lo envia asi)
    marcaTiempo: string;

    tipo: TipoMensajeEntranteWhatsapp;

    // Solo si el tipo es texto y existe cuerpo
    textoPlano?: string;
}
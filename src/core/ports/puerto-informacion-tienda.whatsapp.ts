/**
 * Token de inyeccion de NEST para no depender de la clase concreta de infraestructura
 * El core solo conoce el contrato no HttpService ni GraphQL
 */

import { WhatsappInformacionTiendaCache } from "../whatsapp/informacion-tienda-whatsapp.types";

export const TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP = 'TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP';

/**
 * Lectura de la informacion de tienda en cache (RAM) tras sincronizar WHATSAPP_WEBSCRAPING_URL.
 * El webhook no debe hacer HTTP al JSON en cada mensaje: solo lee esta copia.
 */
export interface PuertoInformacionTiendaWhatsapp {
    /** Ultima copia buena en memoria; null si nunca hubo fetch exitoso (arranque o URL caida). */
    obtenerInformacionTiendaEnCache(): WhatsappInformacionTiendaCache | null;
}
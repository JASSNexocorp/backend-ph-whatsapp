/**
 * Token de inyeccion de NEST para no depender de la clase concreta de infraestructura
 * El core solo conoce el contrato no HttpService ni GraphQL
 */

import { WhatsappMenuSnapshot } from "../whatsapp/informacion-tienda-whatsapp.types";

export const TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP = 'TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP';

/**
 * Lectura de la informacion y sucursales en memoria tras la soncrnizacion WHATSAPP_INFORMACION_URL
 * EL webhook no debe hacer HTTP al JSON en cada mensajes : solo lee el snapshot
 */
export interface PuertoInformacionTiendaWhatsapp {
    // Ultimo snapshot bueno; null si nunca hubo fetch exitoso (arranque o URL caida)
    obtenerSnapshotActual() : WhatsappMenuSnapshot | null;
}
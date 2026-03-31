import { PuertoDeduplicacionMensajes } from "../ports/puerto-deduplicacion-mensaje";
import { PuertoManejadorMensajeEntrante } from "../ports/puerto-manejador-mensaje-entrante";
import { extraerMensajesEntrantesNormalizados } from "../whatsapp/analizador-webhook-meta-whatsapp";

/**
 * Orquesta el POST del webhook : parseo, filtro por phone_number_id (en el analizador),
 * deduplicacion por wamid y entrega al manejar de dominio
 */
export class ProcesarWebhookEntranteWhatsappCasoUso {
    constructor(
        private readonly idNumeroTelefonoNegocio: string,
        private readonly deduplicacion: PuertoDeduplicacionMensajes,
        private readonly manejador: PuertoManejadorMensajeEntrante,
    ){}

    /**
     * Procesa el body crudo del webhook : normaliza, deduplica y delega cada mensaje nuevo
     */
    async ejecutar(cuerpo: unknown): Promise<void> {
        // FASE 1 : Extraemos mensajes que corresponden a nuestro (phone_number_id) 
        const mensajes = extraerMensajesEntrantesNormalizados(cuerpo, this.idNumeroTelefonoNegocio);

        // FASE 2 : Por cada mensaje, reservar wamid y manejar solo si es la primera vez
        for(const mensaje of mensajes){
            const esNuevo = await this.deduplicacion.intentarReservar(mensaje.idMensajeWhatsapp);
            if(!esNuevo){
                continue;
            }
            await this.manejador.manejar(mensaje);
        }
    }
}
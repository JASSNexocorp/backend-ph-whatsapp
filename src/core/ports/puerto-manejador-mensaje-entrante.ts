import { MensajeEntranteWhatsappNormalizado } from "../whatsapp/mensaje-entrante-whatsapp-normalizado";

/**
 * Punto de extesion : aqui despues enganchas cliente/conversacion, nodo del flujo y respuesta 
 * por Graph API de Meta.
 */
export interface PuertoManejadorMensajeEntrante {
    manejar(mensaje: MensajeEntranteWhatsappNormalizado): Promise<void>;
}
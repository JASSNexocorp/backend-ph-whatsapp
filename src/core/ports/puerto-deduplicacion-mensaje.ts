/**
 * Contrato para evitar procesar dos veces el mismo wamid (reintentos de Meta o duplicados).
 * En producción con varias réplicas hace falta un almacén compartido (Redis o tabla).
 */

export interface PuertoDeduplicacionMensajes {
    /**
     * Intenta reservar el id: devuelve true si el mensaje es nuevo (debe procesarse),
     * false si ya se vio (debe ignorarse).
     */
    intentarReservar(idMensajeWhatsapp: string): Promise<boolean>;
  }
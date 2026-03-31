/**
 * Puerto para enviar acciones/mensajes salientes por WhatsApp Graph API de Meta
 * Se modela como puerto para que el core no dependa de HTTP/Nest/Axios
 */
export interface PuertoWhatsappGraphApi {
    // Marca un mensaje entrante como leído usando el message_id (wamid) del webhook.
    // Meta requiere message_id, no el número del cliente.
    marcarComoLeido(idMensajeWhatsapp: string): Promise<void>;

    // Muestra indicador de escritura (typing) asociado al message_id; se descarta al responder o a los 25s.
    // Solo tiene sentido si vas a responder (si no, genera mala UX).
    mostrarIndicadorEscritura(idMensajeWhatsapp: string): Promise<void>;

    // Envía un mensaje de texto plano al número indicado.
    enviarTexto(numeroDestino: string, texto: string): Promise<void>;

    // Envía una imagen por URL (link) al número destino, con caption opcional.
    enviarImagenPorURL(numeroDestino: string, urlImagen: string, caption?: string): Promise<void>;

    // Envía un menú con botones (interactive buttons) con body + footer.
    enviarMensajeBotones(
        numeroDestino: string,
        body: string,
        footer: string,
        botones: Array<{
            id: string;
            texto: string;
        }>
    ): Promise<void>;
}
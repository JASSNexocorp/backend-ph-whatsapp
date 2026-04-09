/**
 * Token de inyección NestJS para el puerto de envío de mensajes de WhatsApp.
 * Permite que los adaptadores dependan de la abstracción y no de la clase concreta de infraestructura.
 */
export const TOKEN_PUERTO_WHATSAPP_GRAPH_API = 'TOKEN_PUERTO_WHATSAPP_GRAPH_API';

/** Fila de un mensaje interactivo tipo lista (Cloud API de Meta). */
export interface WhatsappFilaMensajeLista {
    id: string;
    titulo: string;
    descripcion?: string;
}

/**
 * Puerto para enviar acciones/mensajes salientes por WhatsApp Graph API de Meta.
 * Se modela como puerto para que el core no dependa de HTTP/Nest/Axios.
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

    // Mensaje interactivo de Meta : cuerpo + boton para que el usuario envie su ubicacion
    enviarSolicitudUbicacion(numeroDestino: string, textoCuerpo: string): Promise<void>;

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

    // Envía un mensaje interactivo cta_url: un solo botón que abre una URL en el navegador del usuario.
    // Útil para links de Google Maps o el catálogo web sin exponer la URL cruda en el cuerpo.
    enviarMensajeCtaUrl(
        numeroDestino: string,
        body: string,
        footer: string,
        textoBoton: string,
        urlBoton: string,
    ): Promise<void>;

    /**
     * Mensaje interactivo tipo lista: un botón abre hasta 10 filas (en total, todas las secciones).
     * El id de cada fila vuelve en el webhook como list_reply.
     */
    enviarMensajeListaInteractiva(
        numeroDestino: string,
        entrada: {
            textoEncabezado?: string;
            textoCuerpo: string;
            textoPie?: string;
            textoBotonAccion: string;
            tituloSeccion: string;
            filas: WhatsappFilaMensajeLista[];
        },
    ): Promise<void>;
}
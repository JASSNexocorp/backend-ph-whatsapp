import { PuertoWhatsappGraphApi } from "../ports/puerto-whatsapp-graph-api";
import { MensajeEntranteWhatsappNormalizado } from "../whatsapp/mensaje-entrante-whatsapp-normalizado";

/**
 * Caso de uso : para un mensaje entrante, envia la bienvenida + menu principal
 * Esto implementa el comportamiento pedido por negocio para el primer contacto y para "menu"
 */
export class EnviarBienvenidaYMenuCasoUso {
    constructor(
        private readonly whatsapp : PuertoWhatsappGraphApi,
        private readonly urlImagenBienvenida : string,
    ){}

    /**
     * Envia 2 mensajes : saludo con imagen y luego menu con 2 opciones
     * Tambien marca el mensaje entrante como leido para mostrar "visto"
     */
    async ejecutar(mensaje : MensajeEntranteWhatsappNormalizado) : Promise<void> {
        // PASO 1 : Marcar el mensaje como leido y mostrar (typing)
        await this.whatsapp.marcarComoLeido(mensaje.idMensajeWhatsapp);
        await this.whatsapp.mostrarIndicadorEscritura(mensaje.idMensajeWhatsapp);

        // PASO 2 : Enviar saludo + imagne de portada (configurada en env.)
        await this.whatsapp.enviarImagenPorURL(
            mensaje.numeroWhatsappOrigen,
            this.urlImagenBienvenida,
            '¡Hola! Bienvenid@ a pedidos Pizza Hut 🍕',
        );

        // PASO 3 : Enviar menu principal con 2 opciones y footer para volver con "menu"
        await this.whatsapp.enviarMensajeBotones(
            mensaje.numeroWhatsappOrigen,
            'Selecciona una de las siguientes opciones 👇🏼',
            'En cualquier momento puedes regresar al menú enviando *menu*',
            [
                { id: 'hacer_pedido', texto: 'Hacer pedido' },
                { id: 'otras_opciones', texto : 'Otras opciones' },
            ],
        )
    }
}
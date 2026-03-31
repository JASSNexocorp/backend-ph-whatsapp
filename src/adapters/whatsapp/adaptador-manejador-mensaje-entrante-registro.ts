import { Inject, Injectable, Logger } from "@nestjs/common";
import { PuertoManejadorMensajeEntrante } from "src/core/ports/puerto-manejador-mensaje-entrante";
import { MensajeEntranteWhatsappNormalizado } from "src/core/whatsapp/mensaje-entrante-whatsapp-normalizado";

@Injectable()
export class AdaptadorManejadorMensajeEntranteRegistro implements PuertoManejadorMensajeEntrante {
    private readonly logger = new Logger(AdaptadorManejadorMensajeEntranteRegistro.name);

    async manejar(mensaje: MensajeEntranteWhatsappNormalizado): Promise<void> {
        // JSON.stringify para ver el objeto completo (evita [Array])
        this.logger.log(`Manejando mensaje: ${JSON.stringify(mensaje, null, 2)}`);
    }
}
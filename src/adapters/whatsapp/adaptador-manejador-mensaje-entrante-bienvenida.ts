import { Injectable } from "@nestjs/common";
import { PuertoManejadorMensajeEntrante } from "src/core/ports/puerto-manejador-mensaje-entrante";
import { EnviarBienvenidaYMenuCasoUso } from "src/core/use-cases/enviar-bienvenida-y-menu.caso-uso";
import { MensajeEntranteWhatsappNormalizado } from "src/core/whatsapp/mensaje-entrante-whatsapp-normalizado";

@Injectable()
export class AdaptadorManejadorMensajeEntranteBienvenida implements PuertoManejadorMensajeEntrante {
    constructor(private readonly enviarBienvenidaYMenu: EnviarBienvenidaYMenuCasoUso){}

    async manejar(mensaje: MensajeEntranteWhatsappNormalizado): Promise<void> {
        
        // PASO 1 : Solo reaccionamos a texto por ahora
        if(mensaje.tipo !== 'texto'){
            return;
        }

        const texto = (mensaje.textoPlano ?? '').trim().toLowerCase();

        // PASO 2 : Si el usuario pide menu, reenviamos menu sin discutir estado.
        if(texto === 'menu'){
            await this.enviarBienvenidaYMenu.ejecutar(mensaje);
            return;
        }

        // Comportamiento inicial : si dice cualquier cosa enviamos bienvenida
        // Cuando conectes BD, esto deberia ser "si nodo_actual = inicio"
        await this.enviarBienvenidaYMenu.ejecutar(mensaje);
    }
}
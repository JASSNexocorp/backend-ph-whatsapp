import { Injectable } from "@nestjs/common";
import { PuertoDeduplicacionMensajes } from "src/core/ports/puerto-deduplicacion-mensaje";


/**
 * Deduplicacion en memoria para un solo proceso (desarrollo o instancia unica)
 * Si hay varias replicar, reemplazar por Redis o tabla compartida
 */
@Injectable()
export class AdaptadorDeduplicacionMensajesMemoria implements PuertoDeduplicacionMensajes {
    private readonly idsVistos =  new Set<string>();

    async intentarReservar(idMensajeWhatsapp: string): Promise<boolean> {
        if(this.idsVistos.has(idMensajeWhatsapp)){
            return false;
        }
        this.idsVistos.add(idMensajeWhatsapp);
        return true;
    }
}
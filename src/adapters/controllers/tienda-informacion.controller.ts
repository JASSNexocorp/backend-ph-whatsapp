import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    NotFoundException,
} from '@nestjs/common';
import { TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP } from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import type { PuertoInformacionTiendaWhatsapp } from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import type { WhatsappMenuSnapshot } from 'src/core/whatsapp/informacion-tienda-whatsapp.types';

/**
 * Expone el snapshot del menu/sucursales ya cargado en memoria por WebScrapingPhService.
 * No dispara HTTP al JSON ni a Shopify en cada request — solo lectura del cache en proceso.
 */
@Controller('tienda')
export class TiendaInformacionController {
    constructor(
        @Inject(TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP)
        private readonly informacionTienda: PuertoInformacionTiendaWhatsapp,
    ) {}

    /**
     * Devuelve menu, sucursales (enriquecidas) y configuracion_carrito (costo envio ya efectivo).
     * 404 si nunca hubo fetch exitoso.
     */
    @Get('informacion')
    @HttpCode(HttpStatus.OK)
    obtenerInformacionTienda(): WhatsappMenuSnapshot {
        const informacion = this.informacionTienda.obtenerSnapshotActual();
        if (!informacion) {
            throw new NotFoundException(
                'Informacion de tienda no disponible aun; verifica WHATSAPP_MENU_URL y los logs de arranque.',
            );
        }
        return informacion;
    }
}
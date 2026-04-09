import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { NotificarCarritoWhatsappDto } from 'src/adapters/controllers/dtos/notificar-carrito-whatsapp.dto';
import { NotificarCarritoWebWhatsappService } from 'src/infrastructure/whatsapp/notificar-carrito-web-whatsapp.service';

/**
 * Expone POST para que el menú web confirme el armado del carrito y el backend notifique por WhatsApp.
 * Mismo prefijo `tienda` que el resto de endpoints del catálogo en caché.
 */
@Controller('tienda')
export class NotificarCarritoWebController {
    constructor(private readonly notificarCarritoWeb: NotificarCarritoWebWhatsappService) {}

    /**
     * Recibe JWT + líneas y totales; valida el token y envía al número del cliente el resumen con 3 botones.
     */
    @Post('notificar-carrito')
    @HttpCode(HttpStatus.OK)
    async postNotificarCarrito(@Body() dto: NotificarCarritoWhatsappDto): Promise<{ ok: true }> {
        console.log('dto', dto);
        return this.notificarCarritoWeb.ejecutar(dto);
    }
}

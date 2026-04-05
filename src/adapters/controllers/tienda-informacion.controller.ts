import {
    BadRequestException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    NotFoundException,
    Query,
} from '@nestjs/common';
import { TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP } from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import type { PuertoInformacionTiendaWhatsapp } from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import type {
    WhatsappInformacionTiendaCache,
    WhatsappProductoDetalleTienda,
} from 'src/core/whatsapp/informacion-tienda-whatsapp.types';
import { ShopifyProductByTitleService } from 'src/infrastructure/shopify/shopify-product-by-title.service';

/**
 * Expone la informacion de tienda en cache (colecciones, sucursales, carrito, catalogo opcional) en RAM.
 * No dispara HTTP al JSON ni a Shopify en cada request: solo lectura del proceso.
 */
@Controller('tienda')
export class TiendaInformacionController {
    constructor(
        @Inject(TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP)
        private readonly informacionTienda: PuertoInformacionTiendaWhatsapp,
        private readonly productoPorTitulo: ShopifyProductByTitleService,
    ) {}

    /**
     * Devuelve colecciones (titulo, imagen, productos), sucursales enriquecidas y configuracion_carrito.
     * 404 si nunca hubo fetch exitoso.
     */
    @Get('informacion')
    @HttpCode(HttpStatus.OK)
    obtenerInformacionTienda(): WhatsappInformacionTiendaCache {
        const informacion = this.informacionTienda.obtenerInformacionTiendaEnCache();
        if (!informacion) {
            throw new NotFoundException(
                'Informacion de tienda no disponible aun; verifica WHATSAPP_MENU_URL y los logs de arranque.',
            );
        }
        return informacion;
    }

    /**
     * Busca un producto en Shopify Admin por titulo o por handle (solo digitos => handle, igual que el front legacy).
     * Cada llamada ejecuta GraphQL; no usa la cache de /tienda/informacion.
     */
    @Get('producto')
    @HttpCode(HttpStatus.OK)
    async obtenerProductoPorTitulo(
        @Query('titulo') titulo: string | undefined,
    ): Promise<WhatsappProductoDetalleTienda> {
        const termino = titulo?.trim() ?? '';
        if (!termino) {
            throw new BadRequestException('Query "titulo" es obligatorio (titulo o handle del producto).');
        }
        const producto = await this.productoPorTitulo.obtenerProductoDetallePorTituloOHandle(termino);
        if (!producto) {
            throw new NotFoundException(`No se encontro producto para: ${termino}`);
        }
        return producto;
    }
}
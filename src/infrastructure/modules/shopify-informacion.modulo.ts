import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TiendaInformacionController } from '../../adapters/controllers/tienda-informacion.controller';
import { TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP } from '../../core/ports/puerto-informacion-tienda.whatsapp';
import { ShopifyAdminGraphqlService } from '../shopify/shopify-admin-graphql.service';
import { WebScrapingPhService } from '../shopify/web-scraping-ph.service';

/**
 * Sincronizacion del menu publico + enrichment Shopify (locations / costo envio opcional).
 * Exporta el puerto para inyectarlo en el adaptador de WhatsApp sin acoplar a clases de infra.
 */
@Module({
    imports: [HttpModule],
    controllers: [TiendaInformacionController],
    providers: [
        ShopifyAdminGraphqlService,
        WebScrapingPhService,
        {
            provide: TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP,
            useExisting: WebScrapingPhService,
        },
    ],
    exports: [TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP, WebScrapingPhService],
})
export class ShopifyInformacionModule {}
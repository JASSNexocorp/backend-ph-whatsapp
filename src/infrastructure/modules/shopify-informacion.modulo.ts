import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import { TiendaInformacionController } from '../../adapters/controllers/tienda-informacion.controller';
import { TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP } from '../../core/ports/puerto-informacion-tienda.whatsapp';
import { MenuClienteJwtService } from '../auth/menu-cliente-jwt.service';
import { ShopifyAdminGraphqlService } from '../shopify/shopify-admin-graphql.service';
import { ShopifyCatalogCollectionsService } from '../shopify/shopify-catalog-collections.service';
import { ShopifyProductByTitleService } from '../shopify/shopify-product-by-title.service';
import { WebScrapingPhService } from '../shopify/web-scraping-ph.service';

/**
 * Sincronizacion del JSON publico (colecciones titulo/imagen + sucursales) + enrichment Shopify
 * y catalogo por colecciones; ademas busqueda puntual de producto por titulo/handle (GET /tienda/producto).
 * Exporta el puerto para inyectarlo en el adaptador de WhatsApp sin acoplar a clases de infra.
 */
@Module({
    imports: [
        HttpModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const raw =
                    config.get<string>('JWT_MENU_CLIENTE_EXPIRES_IN') ?? '2h';
                return {
                    secret: config.getOrThrow<string>('JWT_MENU_CLIENTE_SECRET'),
                    signOptions: {
                        expiresIn: raw as SignOptions['expiresIn'],
                    },
                };
            },
        }),
    ],
    controllers: [TiendaInformacionController],
    providers: [
        ShopifyAdminGraphqlService,
        ShopifyCatalogCollectionsService,
        ShopifyProductByTitleService,
        WebScrapingPhService,
        MenuClienteJwtService,
        {
            provide: TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP,
            useExisting: WebScrapingPhService,
        },
    ],
    exports: [
        TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP,
        WebScrapingPhService,
        MenuClienteJwtService,
        ShopifyAdminGraphqlService,
    ],
})
export class ShopifyInformacionModule {}
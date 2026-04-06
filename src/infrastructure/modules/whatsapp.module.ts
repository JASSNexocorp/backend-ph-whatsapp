import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { DatabaseModule } from "../database/database.module";
import { ConfigService } from "@nestjs/config";
import { WhatsAppGraphApiService } from "../external-services/whatsapp-graph-api.service";
import { TOKEN_PUERTO_WHATSAPP_GRAPH_API } from '../../core/ports/puerto-whatsapp-graph-api';
import { NotificarCarritoWebController } from '../../adapters/controllers/notificar-carrito-web.controller';
import { WhatsAppWebhookController } from '../../adapters/controllers/whatsapp-webhook.controller';
import { AdaptadorDeduplicacionMensajesMemoria } from '../../adapters/whatsapp/adaptador-deduplicacion-mensajes-memoria';
import { AdaptadorManejadorMensajeEntranteFlujoDomicilio } from '../../adapters/whatsapp/adaptador-manejador-mensaje-entrante-flujo-domicilio';
import { NotificarCarritoWebWhatsappCasoUso } from '../../core/use-cases/notificar-carrito-web-whatsapp.caso-uso';
import { ProcesarWebhookEntranteWhatsappCasoUso } from '../../core/use-cases/procesar-webhook-entrante-whatsapp.caso-uso';
import { NotificarCarritoWebWhatsappService } from '../whatsapp/notificar-carrito-web-whatsapp.service';
import { ShopifyInformacionModule } from './shopify-informacion.modulo';

/**
 * Módulo WhatsApp: Webhook + cliente HTTP hacia Graph API para enviar mensajes.
 * Separa el transporte Meta del núcleo de reglas de compra.
 */
@Module({
    imports: [
        // HttpModule expone HttpService, requerido por WhatsAppGraphApiService.
        HttpModule,
        DatabaseModule,
        ShopifyInformacionModule,
    ],
    controllers: [WhatsAppWebhookController, NotificarCarritoWebController],
    providers: [
        // Implementación concreta del puerto de envío de mensajes WhatsApp.
        WhatsAppGraphApiService,

        // Alias del token del puerto para que los adaptadores dependan de la abstracción, no de la clase.
        {
            provide: TOKEN_PUERTO_WHATSAPP_GRAPH_API,
            useExisting: WhatsAppGraphApiService,
        },

        {
            provide: NotificarCarritoWebWhatsappCasoUso,
            useFactory: (api: WhatsAppGraphApiService) =>
                new NotificarCarritoWebWhatsappCasoUso(api),
            inject: [WhatsAppGraphApiService],
        },

        NotificarCarritoWebWhatsappService,

        // DeDuplicacion (MVP)
        AdaptadorDeduplicacionMensajesMemoria,

        // Handler de flujo de compra (menú, tipo pedido, domicilio, etc.).
        AdaptadorManejadorMensajeEntranteFlujoDomicilio,

        // Orquestador principal del webhook entrante.
        {
            provide: ProcesarWebhookEntranteWhatsappCasoUso,
            useFactory: (
                config: ConfigService,
                deduplicacion: AdaptadorDeduplicacionMensajesMemoria,
                manejador: AdaptadorManejadorMensajeEntranteFlujoDomicilio,
            ) =>
                new ProcesarWebhookEntranteWhatsappCasoUso(
                    config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER_ID'),
                    deduplicacion,
                    manejador,
                ),
            inject: [
                ConfigService,
                AdaptadorDeduplicacionMensajesMemoria,
                AdaptadorManejadorMensajeEntranteFlujoDomicilio,
            ],
        },
    ]
})
export class WhatsAppModule { }
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { DatabaseModule } from "../database/database.module";
import { ConfigService } from "@nestjs/config";
import { WhatsAppGraphApiService } from "../external-services/whatsapp-graph-api.service";
import { WhatsAppWebhookController } from '../../adapters/controllers/whatsapp-webhook.controller';
import { AdaptadorDeduplicacionMensajesMemoria } from '../../adapters/whatsapp/adaptador-deduplicacion-mensajes-memoria';
import { AdaptadorManejadorMensajeEntranteFlujoDomicilio } from '../../adapters/whatsapp/adaptador-manejador-mensaje-entrante-flujo-domicilio';
import { ProcesarWebhookEntranteWhatsappCasoUso } from '../../core/use-cases/procesar-webhook-entrante-whatsapp.caso-uso';
import { ShopifyInformacionModule } from './shopify-informacion.modulo';

/**
 * Modulo WhatsApp : WebHook + (mas adelante) cliente HTTP hacia Graph API para enviar mensajes
 * Separa el transporte Meta de nucleo de reglas de compra
*/
@Module({
    imports: [
        // HttpModule expone HttpService, requerido por WhatsAppGraphApiService.
        HttpModule,
        DatabaseModule,
        ShopifyInformacionModule,
    ],
    controllers: [WhatsAppWebhookController],
    providers: [
        // Infraestructura para enviar mensajes y marcar como leído.
        WhatsAppGraphApiService,

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
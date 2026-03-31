import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { WhatsAppWebhookController } from "src/adapters/controllers/whatsapp-webhook.controller";
import { AdaptadorDeduplicacionMensajesMemoria } from "src/adapters/whatsapp/adaptador-deduplicacion-mensajes-memoria";
import { AdaptadorManejadorMensajeEntranteRegistro } from "src/adapters/whatsapp/adaptador-manejador-mensaje-entrante-registro";
import { ProcesarWebhookEntranteWhatsappCasoUso } from "src/core/use-cases/procesar-webhook-entrante-whatsapp.caso-uso";
import { ConfigService } from "@nestjs/config";
import { WhatsAppGraphApiService } from "../external-services/whatsapp-graph-api.service";
import { EnviarBienvenidaYMenuCasoUso } from "src/core/use-cases/enviar-bienvenida-y-menu.caso-uso";
import { AdaptadorManejadorMensajeEntranteBienvenida } from "src/adapters/whatsapp/adaptador-manejador-mensaje-entrante-bienvenida";

/**
 * Modulo WhatsApp : WebHook + (mas adelante) cliente HTTP hacia Graph API para enviar mensajes
 * Separa el transporte Meta de nucleo de reglas de compra
*/
@Module({
    imports: [DatabaseModule],
    controllers: [WhatsAppWebhookController],
    providers: [
        // Infraestructura para enviar mensajes y marcar como leído.
        WhatsAppGraphApiService,

        // DeDuplicacion (MVP)
        AdaptadorDeduplicacionMensajesMemoria,

        // Caso de uso de bienvenida.
        {
            provide: EnviarBienvenidaYMenuCasoUso,
            useFactory: (config: ConfigService, whatsapp: WhatsAppGraphApiService) =>
                new EnviarBienvenidaYMenuCasoUso(
                    whatsapp,
                    config.getOrThrow<string>('IMAGE_BANNER'),
                ),
            inject: [ConfigService, WhatsAppGraphApiService],
        },

        // Handler de mensajes entrantes: decide cuándo mandar bienvenida/menú.
        AdaptadorManejadorMensajeEntranteBienvenida,

        // Orquestador principal del webhook entrante.
        {
            provide: ProcesarWebhookEntranteWhatsappCasoUso,
            useFactory: (
                config: ConfigService,
                deduplicacion: AdaptadorDeduplicacionMensajesMemoria,
                manejador: AdaptadorManejadorMensajeEntranteBienvenida,
            ) =>
                new ProcesarWebhookEntranteWhatsappCasoUso(
                    config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER_ID'),
                    deduplicacion,
                    manejador,
                ),
            inject: [
                ConfigService,
                AdaptadorDeduplicacionMensajesMemoria,
                AdaptadorManejadorMensajeEntranteBienvenida,
            ],
        },
    ]
})
export class WhatsAppModule { }
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { WhatsAppMenuMapping } from '../external-services/whatsapp-menu-scraper.service';
import { WhatsAppMenuScraperService } from '../external-services/whatsapp-menu-scraper.service';
import { WhatsAppSenderService } from '../external-services/whatsapp-sender.adapter';
import {
  extractMessagesFromMeta,
  type MetaMessage,
} from '../../core/whatsapp/parsers/whatsapp-meta-parser';
import { ClienteWhatsappRepositoryPostgres } from '../repositories/cliente-whatsapp.repository.postgres';
import { ConversacionWhatsappRepositoryPostgres } from '../repositories/conversacion-whatsapp.repository.postgres';
import { ProcesarMensajeWhatsAppUseCase } from '../../core/whatsapp/use-cases/procesar-mensaje-whatsapp.use-case';

// Webhook de WhatsApp (Meta) para recibir mensajes.
// - GET: handshake de verificación con `hub.challenge`
// - POST: eventos de WhatsApp; filtramos para quedarnos solo con `messages`
@Controller('webhook/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);
  private readonly useCase: ProcesarMensajeWhatsAppUseCase;
  constructor(
    private readonly menuScraperService: WhatsAppMenuScraperService,
    private readonly senderService: WhatsAppSenderService,
    private readonly clienteRepo: ClienteWhatsappRepositoryPostgres,
    private readonly conversacionRepo: ConversacionWhatsappRepositoryPostgres,
  ) {
    this.useCase = new ProcesarMensajeWhatsAppUseCase(
      this.clienteRepo,
      this.conversacionRepo,
      this.senderService,
    );
  }

  // Evitamos usar ConfigModule para mantener el scaffold mínimo.
  private get expectedVerifyToken(): string {
    // Soportamos ambos nombres (el proyecto usa `TOKEN_VERIFICAR_WEBHOOK`,
    // pero el controller tenía `WHATSAPP_VERIFY_TOKEN`).
    return (
      process.env.WHATSAPP_VERIFY_TOKEN ??
      process.env.TOKEN_VERIFICAR_WEBHOOK ??
      ''
    );
  }

  // ── FASE 1: Verificación de webhook (Meta llama para confirmar el token) ─────
  @Get()
  getWebhookVerification(
    @Query('hub.mode') hubMode: string,
    @Query('hub.verify_token') hubVerifyToken: string,
    @Query('hub.challenge') hubChallenge: string,
    @Res() res: Response,
  ) {
    const expected = this.expectedVerifyToken;

    // Log liviano para depurar handshake (sin imprimir el token en sí).
    console.log('Webhook GET de WhatsApp recibido:', {
      hubMode,
      verifyTokenMatches: !!expected && hubVerifyToken === expected,
      challengePresent: !!hubChallenge,
      challengeLength: hubChallenge ? hubChallenge.length : 0,
    });

    if (!expected) {
      return res.status(500).send('WHATSAPP_VERIFY_TOKEN no configurado');
    }

    if (hubMode !== 'subscribe') {
      return res.status(400).send('Modo inválido');
    }

    if (!hubVerifyToken || hubVerifyToken !== expected) {
      return res.status(403).send('Token de verificación inválido');
    }

    if (!hubChallenge) {
      return res.status(400).send('Falta hub.challenge');
    }

    // Meta espera que devolvamos el `hub.challenge` como texto plano.
    return res.status(200).send(hubChallenge);
  }

  // ── FASE 2: Recepción de mensajes (Meta envía eventos al POST) ─────────────
  @Post()
  @HttpCode(200)
  handleWebhook(@Body() body: unknown): {
    received: true;
    messagesCount: number;
    messages: MetaMessage[];
  } {
    // ── FASE 1: Refresh del menú (no bloqueante, TTL 30m) ────────────────
    // Aseguramos que el mapeo del menú se mantenga caliente (cache TTL 30m).
    // No bloqueamos la respuesta del webhook por scraping.
    void this.menuScraperService.getMenuMapping().catch((err) => {
      console.warn(
        'No se pudo refrescar el mapeo del menú de WhatsApp (no bloqueante):',
        err instanceof Error ? err.message : err,
      );
    });

    // ── FASE 2: Extraer mensajes del payload Meta ────────────────────────
    const extractedMessages = extractMessagesFromMeta(body);

    const menuMappingPromise = this.menuScraperService.getMenuMapping();
    void Promise.allSettled(
      extractedMessages.map((msg) =>
        this.processIncomingMessage(msg, menuMappingPromise),
      ),
    );

    // ── FASE 3: Log y respuesta para Meta ─────────────────────────────────
    if (extractedMessages.length > 0) {
      // Log "en crudo": mostramos exactamente lo que se extrajo del payload
      // (sin imprimir un resumen adicional para evitar duplicación).
      console.log('Mensajes de WhatsApp recibidos (raw):', extractedMessages);
    }

    // Meta normalmente no depende del body de respuesta (solo requiere 200),
    // pero incluir mensajes ayuda a inspeccionar la respuesta durante pruebas.
    return {
      received: true,
      messagesCount: extractedMessages.length,
      messages: extractedMessages.slice(0, 5),
    };
  }

  private async processIncomingMessage(
    msg: MetaMessage,
    menuMappingPromise: Promise<WhatsAppMenuMapping>,
  ): Promise<void> {
    if (!msg.from || !msg.messageId) return;

    try {
      const menuMapping = await menuMappingPromise;

      const context = {
        menuMapping: menuMapping as any,
        bannerImageLink: process.env.IMAGE_BANNER,
        menuUrl: process.env.WHATSAPP_MENU_URL,
      };

      await this.useCase.execute({
        numeroWhatsapp: msg.from,
        messageId: msg.messageId,
        input: {
          text: msg.text,
          buttonReplyId: msg.buttonReply?.id,
          location:
            msg.location?.latitude !== undefined &&
            msg.location?.longitude !== undefined
              ? {
                  latitude: msg.location.latitude,
                  longitude: msg.location.longitude,
                }
              : undefined,
          messageType: msg.type,
        },
        context,
      });
    } catch (err) {
      this.logger.error('Error procesando mensaje de WhatsApp', err);
    }
  }

  // Endpoint auxiliar para validar rápido que el scraper funciona.
  // No lo usa Meta para el webhook; es solo diagnóstico.
  @Get('menu-mapping')
  async getMenuMapping(): Promise<WhatsAppMenuMapping> {
    // Nota: este endpoint existe solo para observar/debug el mapeo cargado.
    return await this.menuScraperService.getMenuMapping();
  }
}


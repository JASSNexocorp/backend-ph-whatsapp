import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
  } from '@nestjs/common';
  import { ConfigService } from '@nestjs/config';
  import { ProcesarWebhookEntranteWhatsappCasoUso } from '../../core/use-cases/procesar-webhook-entrante-whatsapp.caso-uso';
  
  /**
   * Punto de entrada HTTP para Meta: verificación (GET) y notificaciones (POST).
   * Las respuestas al cliente salen por Graph API (otro adaptador), no por este controlador.
   */
  @Controller('whatsapp/webhook')
  export class WhatsAppWebhookController {
    constructor(
      private readonly config: ConfigService,
      private readonly procesarWebhookEntrante: ProcesarWebhookEntranteWhatsappCasoUso,
    ) {}
  
    /**
     * Meta valida la URL comparando hub.verify_token con TOKEN_VERIFICAR_WEBHOOK en .env.
     */
    @Get()
    verificarWebhook(
      @Query('hub.mode') modo: string,
      @Query('hub.verify_token') token: string,
      @Query('hub.challenge') desafio: string,
    ): string {
      const tokenEsperado = this.config.getOrThrow<string>('TOKEN_VERIFICAR_WEBHOOK');
      if (modo === 'subscribe' && token === tokenEsperado) {
        return desafio ?? '';
      }
      throw new BadRequestException('Verificacion de webhook rechazada');
    }
  
    /**
     * Responde 200 rápido para que Meta no reintente; el trabajo pesado va al caso de uso.
     */
    @Post()
    @HttpCode(HttpStatus.OK)
    async manejarEvento(@Body() cuerpo: unknown): Promise<{ ok: true }> {
      await this.procesarWebhookEntrante.ejecutar(cuerpo);
      return { ok: true };
    }
  }
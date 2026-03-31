import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { PuertoWhatsappGraphApi } from "src/core/ports/puerto-whatsapp-graph-api";

/**
 *  Implementacion HTTP del puerto usando WhatsApp Graph API de Meta
 * Se encarga solo del transporte : armar request, headers y manejar errores HTTP
 */
@Injectable()
export class WhatsAppGraphApiService implements PuertoWhatsappGraphApi {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) { }

  private get baseUrl(): string {
    return this.config.getOrThrow<string>('URL_BASE_GRAPH_API');
  }

  private get versionApi(): string {
    return this.config.getOrThrow<string>('VERSION_API');
  }

  private get phoneNumberId(): string {
    return this.config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER_ID');
  }

  private get token(): string {
    return this.config.getOrThrow<string>('TOKEN_ENVIAR_MSG');
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
  }

  async marcarComoLeido(idMensajeWhatsapp: string): Promise<void> {
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: idMensajeWhatsapp,
        },
        { headers: this.headers }
      )
    );
  }

  async mostrarIndicadorEscritura(idMensajeWhatsapp: string): Promise<void> {
    // Meta permite enviar typing indicator en el mismo endpoint /messages.
    // Se descarta al responder o tras 25 segundos.
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: idMensajeWhatsapp,
          typing_indicator: {
            type: 'text',
          },
        },
        { headers: this.headers }
      )
    );
  }
  
  async enviarTexto(numeroDestino: string, texto: string): Promise<void> {
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: numeroDestino,
          type: 'text',
          text: {
            body: texto,
          },
        },
        { headers: this.headers }
      )
    )
  }

  async enviarImagenPorURL(numeroDestino: string, urlImagen: string, caption?: string): Promise<void> {
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: numeroDestino,
          type: 'image',
          image: {
            link: urlImagen,
            ...(caption ? { caption } : {}),
          }
        },
        { headers: this.headers }
      )
    )
  }

  async enviarMensajeBotones(numeroDestino: string, body: string, footer: string, botones: Array<{ id: string; texto: string; }>): Promise<void> {
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;

    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: numeroDestino,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: body,
            },
            footer: {
              text: footer,
            },
            action: {
              buttons: botones.map(boton => ({
                type: 'reply',
                reply: {
                  id: boton.id,
                  title: boton.texto,
                }
              }))
            }
          }
        },
        { headers: this.headers }
      )
    )
  }
}
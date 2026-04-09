import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import {
  PuertoWhatsappGraphApi,
  WhatsappFilaMensajeLista,
} from "../../core/ports/puerto-whatsapp-graph-api";

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

  async enviarMensajeListaInteractiva(
    numeroDestino: string,
    entrada: {
      textoEncabezado?: string;
      textoCuerpo: string;
      textoPie?: string;
      textoBotonAccion: string;
      tituloSeccion: string;
      filas: WhatsappFilaMensajeLista[];
    },
  ): Promise<void> {
    // Meta: máximo 10 filas en total entre todas las secciones.
    const filas = entrada.filas.slice(0, 10);

    const truncar = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + '…');

    // El id de fila no puede llevar "…" ni caracteres raros: solo recorte duro (Meta 131009 si el id es inválido).
    const truncarIdFila = (s: string, max: number) => s.trim().slice(0, max);

    // Título y descripción: sin saltos de línea (la API de lista es estricta).
    const unaLinea = (s: string) => s.replace(/\s+/g, ' ').trim();

    const rows = filas.map((f) => ({
      id: truncarIdFila(f.id, 200),
      title: truncar(unaLinea(f.titulo), 24),
      ...(f.descripcion?.trim()
        ? { description: truncar(unaLinea(f.descripcion), 72) }
        : {}),
    }));

    const interactive: Record<string, unknown> = {
      type: 'list',
      body: { text: truncar(entrada.textoCuerpo.trim(), 4096) },
      action: {
        button: truncar(entrada.textoBotonAccion.trim(), 20),
        sections: [
          {
            title: truncar(entrada.tituloSeccion.trim(), 24),
            rows,
          },
        ],
      },
    };

    const encabezado = entrada.textoEncabezado?.trim();
    if (encabezado) {
      interactive.header = { type: 'text', text: truncar(encabezado, 60) };
    }
    const pie = entrada.textoPie?.trim();
    if (pie) {
      interactive.footer = { text: truncar(pie, 60) };
    }

    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: numeroDestino,
          type: 'interactive',
          interactive,
        },
        { headers: this.headers },
      ),
    );
  }

  // Envía un mensaje interactivo de tipo cta_url: un botón que abre una URL externa.
  // Meta no muestra la URL cruda en el cuerpo, solo el label del botón — mejor UX para links largos.
  async enviarMensajeCtaUrl(
    numeroDestino: string,
    body: string,
    footer: string,
    textoBoton: string,
    urlBoton: string,
  ): Promise<void> {
    // Límites oficiales CTA URL (Cloud API): body 1024, footer 60, display_text 20 — si se pasan → 131009.
    const textoCuerpo = body.trim().slice(0, 1024);
    const textoPie = footer.trim().slice(0, 60);
    const etiquetaBoton = textoBoton.trim().slice(0, 20);

    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: numeroDestino,
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            body: { text: textoCuerpo },
            ...(textoPie ? { footer: { text: textoPie } } : {}),
            action: {
              name: 'cta_url',
              parameters: {
                display_text: etiquetaBoton,
                url: urlBoton.trim(),
              },
            },
          },
        },
        { headers: this.headers },
      ),
    );
  }

  async enviarSolicitudUbicacion(numeroDestino: string, textoCuerpo: string): Promise<void> {
    const url = `${this.baseUrl}/${this.versionApi}/${this.phoneNumberId}/messages`;
    await firstValueFrom(
      this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: numeroDestino,
          type: 'interactive',
          interactive: {
            type: 'location_request_message',
            body: {
              text: textoCuerpo,
            },
            action: {
              name: 'send_location',
            },
          },
        },
        { headers: this.headers },
      ),
    );
  }
}
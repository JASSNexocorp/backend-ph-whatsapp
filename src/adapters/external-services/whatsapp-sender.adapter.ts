import { Injectable } from '@nestjs/common';
import type {
  OutgoingInteractiveReplyButtonsMessage,
  OutgoingMessage,
} from '../../core/whatsapp/types/outgoing-message.type';

export type { OutgoingMessage } from '../../core/whatsapp/types/outgoing-message.type';

/**
 * Adapter Meta Cloud API para enviar mensajes por WhatsApp.
 */
@Injectable()
export class WhatsAppSenderService {
  private readonly apiVersion = process.env.WHATSAPP_API_VERSION ?? 'v25.0';
  private readonly token = process.env.TOKEN_ENVIAR_MSG;
  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  private assertConfig(): void {
    if (!this.token) {
      throw new Error('Falta TOKEN_ENVIAR_MSG en el entorno');
    }
    if (!this.phoneNumberId) {
      throw new Error('Falta WHATSAPP_PHONE_NUMBER_ID en el entorno');
    }
  }

  /**
   * Marca el mensaje entrante como leído y dispara typing indicator (texto).
   * Según Meta, se hace en el mismo endpoint usando `status: "read"`.
   */
  async markReadAndTyping(messageId: string): Promise<void> {
    this.assertConfig();

    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    };

    await this.postMessage(payload);
  }

  async send(to: string, message: OutgoingMessage): Promise<void> {
    this.assertConfig();

    if (message.kind === 'text') {
      await this.postMessage({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: message.text },
      });
      return;
    }

    if (message.kind === 'image') {
      await this.postMessage({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { link: message.imageLink },
        ...(message.caption ? { caption: message.caption } : {}),
      });
      return;
    }

    const interactive = message as OutgoingInteractiveReplyButtonsMessage;
    await this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(interactive.headerImage
          ? {
              header: {
                type: 'image',
                image: { link: interactive.headerImage.link },
              },
            }
          : {}),
        body: { text: interactive.bodyText },
        ...(interactive.footerText ? { footer: { text: interactive.footerText } } : {}),
        action: {
          buttons: interactive.buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  async sendMany(to: string, messages: OutgoingMessage[]): Promise<void> {
    for (const m of messages) {
      await this.send(to, m);
    }
  }

  private async postMessage(payload: unknown): Promise<void> {
    this.assertConfig();

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Error enviando mensaje a Meta (HTTP ${res.status}): ${body}`,
      );
    }
  }

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }
}


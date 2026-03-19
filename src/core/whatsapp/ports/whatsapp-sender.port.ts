import type { OutgoingMessage } from '../types/outgoing-message.type';

export interface WhatsAppSenderPort {
  markReadAndTyping(messageId: string): Promise<void>;
  sendMany(to: string, messages: OutgoingMessage[]): Promise<void>;
}


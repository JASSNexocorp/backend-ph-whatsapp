import type { FlowContext, FlowInput } from '../whatsapp-flow.engine';
import { WhatsAppFlowEngine } from '../whatsapp-flow.engine';
import type { ConversacionModel } from '../ports/conversacion-whatsapp.repository.port';
import type { ClienteModel, ClienteWhatsappRepositoryPort } from '../ports/cliente-whatsapp.repository.port';
import type { ConversacionWhatsappRepositoryPort } from '../ports/conversacion-whatsapp.repository.port';
import type { WhatsAppSenderPort } from '../ports/whatsapp-sender.port';
import type { WhatsAppMenuMapping } from '../types/menu-mapping.type';
import type { OutgoingMessage } from '../types/outgoing-message.type';

export type ProcesoMensajeEntrada = {
  numeroWhatsapp: string;
  messageId: string;
  input: {
    text?: string;
    buttonReplyId?: string;
    location?: { latitude?: number; longitude?: number };
    messageType?: string;
  };
  context: {
    menuMapping: WhatsAppMenuMapping;
    bannerImageLink?: string;
    menuUrl?: string;
  };
};

/**
 * Use case core: procesa un mensaje entrante de WhatsApp.
 * Orquesta:
 * 1) marcar como leído + typing,
 * 2) cargar/crear cliente y conversación,
 * 3) reset/expiración,
 * 4) ejecutar engine del flujo,
 * 5) persistir estado y enviar mensajes.
 */
export class ProcesarMensajeWhatsAppUseCase {
  constructor(
    private readonly clienteRepo: ClienteWhatsappRepositoryPort,
    private readonly conversacionRepo: ConversacionWhatsappRepositoryPort,
    private readonly senderPort: WhatsAppSenderPort,
    private readonly flowEngine: WhatsAppFlowEngine = new WhatsAppFlowEngine(),
  ) {}

  async execute(params: ProcesoMensajeEntrada): Promise<OutgoingMessage[]> {
    const { numeroWhatsapp, messageId, input, context } = params;

    // FASE 1: Side-effect temprano (Meta)
    await this.senderPort.markReadAndTyping(messageId);

    // FASE 2: Cargar/crear cliente + conversación
    let cliente = await this.clienteRepo.findActiveByNumeroWhatsapp(numeroWhatsapp);

    if (!cliente) {
      cliente = await this.clienteRepo.createCliente(numeroWhatsapp);
    }

    let conversacion = await this.conversacionRepo.findByIdCliente(cliente.idCliente);
    if (!conversacion) {
      const tipoFlujo: 'primera_compra' | 'segunda_compra' = cliente.shopifyClienteId
        ? 'segunda_compra'
        : 'primera_compra';

      conversacion = await this.conversacionRepo.createConversacion({
        idCliente: cliente.idCliente,
        tipoFlujo,
      });
    }

    // FASE 3: Expiración / TTL
    const now = new Date();
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const isExpired = conversacion.expiraEn && conversacion.expiraEn.getTime() < now.getTime();

    if (isExpired) {
      conversacion.nodoActual = 'inicio';
      conversacion.carrito = [];
    }

    // Extendemos TTL en cada interacción
    conversacion.ultimaActividad = now;
    conversacion.fechaActualizacion = now;
    conversacion.expiraEn = new Date(now.getTime() + twoHoursMs);

    // FASE 4: Ejecutar engine del flujo (decisión pura)
    const flowResult = this.flowEngine.handleFlow({
      tipoFlujo: conversacion.tipoFlujo,
      nodoActual: conversacion.nodoActual,
      carrito: conversacion.carrito,
      input: {
        text: input.text,
        buttonReplyId: input.buttonReplyId,
        location: input.location,
        messageType: input.messageType,
      } satisfies FlowInput,
      context: {
        menuMapping: context.menuMapping,
        bannerImageLink: context.bannerImageLink,
        menuUrl: context.menuUrl,
      } satisfies FlowContext,
    });

    // FASE 5: Persistir estado
    conversacion.nodoActual = flowResult.nextNode;
    conversacion.carrito = flowResult.carrito;
    conversacion.ultimaActividad = now;
    conversacion.fechaActualizacion = now;

    await this.conversacionRepo.saveConversacion(conversacion);

    // FASE 6: Responder al cliente
    await this.senderPort.sendMany(numeroWhatsapp, flowResult.outgoingMessages);
    return flowResult.outgoingMessages;
  }
}


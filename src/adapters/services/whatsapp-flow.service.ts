import { Injectable } from '@nestjs/common';
import { WhatsAppFlowEngine } from '../../core/whatsapp/whatsapp-flow.engine';
import type { FlowContext, FlowInput, FlowResult } from '../../core/whatsapp/whatsapp-flow.engine';

/**
 * Adapter Nest para el motor puro del flujo WhatsApp (queda delgado).
 */
@Injectable()
export class WhatsAppFlowService {
  private readonly engine = new WhatsAppFlowEngine();

  handleFlow(params: {
    tipoFlujo: 'primera_compra' | 'segunda_compra';
    nodoActual: string;
    carrito: unknown;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    return this.engine.handleFlow(params);
  }
}


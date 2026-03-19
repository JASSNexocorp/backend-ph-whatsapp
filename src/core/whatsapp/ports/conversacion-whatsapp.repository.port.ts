export type ConversacionModel = {
  idConversacion: number;
  idCliente: number;
  tipoFlujo: 'primera_compra' | 'segunda_compra';
  nodoActual: string;
  carrito: unknown;
  ultimaActividad: Date;
  expiraEn: Date;
  fechaActualizacion: Date;
  activo: boolean;
};

export interface ConversacionWhatsappRepositoryPort {
  findByIdCliente(idCliente: number): Promise<ConversacionModel | null>;
  createConversacion(params: {
    idCliente: number;
    tipoFlujo: 'primera_compra' | 'segunda_compra';
  }): Promise<ConversacionModel>;
  saveConversacion(conversacion: ConversacionModel): Promise<void>;
}


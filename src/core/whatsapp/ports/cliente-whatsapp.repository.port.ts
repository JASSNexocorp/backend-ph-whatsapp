export type ClienteModel = {
  idCliente: number;
  numeroWhatsapp: string;
  shopifyClienteId: string | null;
  activo: boolean;
};

export interface ClienteWhatsappRepositoryPort {
  findActiveByNumeroWhatsapp(
    numeroWhatsapp: string,
  ): Promise<ClienteModel | null>;
  createCliente(numeroWhatsapp: string): Promise<ClienteModel>;
}


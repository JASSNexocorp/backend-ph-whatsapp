import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  ClienteModel,
  ClienteWhatsappRepositoryPort,
} from '../../core/whatsapp/ports/cliente-whatsapp.repository.port';
import { ClienteWhatsAppEntity } from '../../infrastructure/database/whatsapp/cliente-whatsapp.orm-entity';

/**
 * Adapter TypeORM/Postgres para acceder a `CLIENTE_WHATSAPP`.
 */
@Injectable()
export class ClienteWhatsappRepositoryPostgres
  implements ClienteWhatsappRepositoryPort
{
  constructor(private readonly dataSource: DataSource) {}

  async findActiveByNumeroWhatsapp(
    numeroWhatsapp: string,
  ): Promise<ClienteModel | null> {
    const repo = this.dataSource.getRepository(ClienteWhatsAppEntity);

    const cliente = await repo.findOne({
      where: { numeroWhatsapp, activo: true },
    });

    if (!cliente) return null;

    return {
      idCliente: cliente.idCliente,
      numeroWhatsapp: cliente.numeroWhatsapp,
      shopifyClienteId: cliente.shopifyClienteId,
      activo: cliente.activo,
    };
  }

  async createCliente(numeroWhatsapp: string): Promise<ClienteModel> {
    const repo = this.dataSource.getRepository(ClienteWhatsAppEntity);

    const cliente = repo.create({
      numeroWhatsapp,
      nombre: null,
      shopifyClienteId: null,
      activo: true,
    });

    const saved = await repo.save(cliente);

    return {
      idCliente: saved.idCliente,
      numeroWhatsapp: saved.numeroWhatsapp,
      shopifyClienteId: saved.shopifyClienteId,
      activo: saved.activo,
    };
  }
}


import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  ConversacionModel,
  ConversacionWhatsappRepositoryPort,
} from '../../core/whatsapp/ports/conversacion-whatsapp.repository.port';
import { ConversacionWhatsAppEntity } from '../../infrastructure/database/whatsapp/conversacion-whatsapp.orm-entity';

/**
 * Adapter TypeORM/Postgres para acceder a `CONVERSACION_WHATSAPP`.
 */
@Injectable()
export class ConversacionWhatsappRepositoryPostgres
  implements ConversacionWhatsappRepositoryPort
{
  constructor(private readonly dataSource: DataSource) {}

  async findByIdCliente(idCliente: number): Promise<ConversacionModel | null> {
    const repo = this.dataSource.getRepository(ConversacionWhatsAppEntity);

    const conversacion = await repo.findOne({
      where: { idCliente },
    });

    if (!conversacion) return null;

    return {
      idConversacion: conversacion.idConversacion,
      idCliente: conversacion.idCliente,
      tipoFlujo: conversacion.tipoFlujo,
      nodoActual: conversacion.nodoActual,
      carrito: conversacion.carrito,
      ultimaActividad: conversacion.ultimaActividad,
      expiraEn: conversacion.expiraEn,
      fechaActualizacion: conversacion.fechaActualizacion,
      activo: conversacion.activo,
    };
  }

  async createConversacion(params: {
    idCliente: number;
    tipoFlujo: 'primera_compra' | 'segunda_compra';
  }): Promise<ConversacionModel> {
    const repo = this.dataSource.getRepository(ConversacionWhatsAppEntity);

    const conversacion = repo.create({
      idCliente: params.idCliente,
      tipoFlujo: params.tipoFlujo,
      nodoActual: 'inicio',
      carrito: [],
      activo: true,
    });

    const saved = await repo.save(conversacion);

    return {
      idConversacion: saved.idConversacion,
      idCliente: saved.idCliente,
      tipoFlujo: saved.tipoFlujo,
      nodoActual: saved.nodoActual,
      carrito: saved.carrito,
      ultimaActividad: saved.ultimaActividad,
      expiraEn: saved.expiraEn,
      fechaActualizacion: saved.fechaActualizacion,
      activo: saved.activo,
    };
  }

  async saveConversacion(conversacion: ConversacionModel): Promise<void> {
    const repo = this.dataSource.getRepository(ConversacionWhatsAppEntity);

    // Usamos la key primaria del modelo para persistir.
    await repo.save({
      idConversacion: conversacion.idConversacion,
      idCliente: conversacion.idCliente,
      tipoFlujo: conversacion.tipoFlujo,
      nodoActual: conversacion.nodoActual,
      carrito: conversacion.carrito,
      ultimaActividad: conversacion.ultimaActividad,
      expiraEn: conversacion.expiraEn,
      fechaActualizacion: conversacion.fechaActualizacion,
      activo: conversacion.activo,
    } as ConversacionWhatsAppEntity);
  }
}


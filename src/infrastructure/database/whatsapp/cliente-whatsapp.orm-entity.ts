import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Persistencia del cliente identificado por su número WhatsApp.
 * La BD guarda el "activo" para soft delete (sin borrar físicamente).
 */
@Entity({ name: 'CLIENTE_WHATSAPP' })
@Index('idx_cliente_whatsapp_numero', ['numeroWhatsapp'])
@Index('idx_cliente_whatsapp_shopify', ['shopifyClienteId'])
@Index('idx_cliente_whatsapp_activo', ['activo'])
export class ClienteWhatsAppEntity {
  @PrimaryGeneratedColumn({ name: 'id_cliente', type: 'int' })
  idCliente!: number;

  @Column({
    name: 'numero_whatsapp',
    type: 'varchar',
    length: 20,
    unique: true,
  })
  numeroWhatsapp!: string;

  @Column({
    name: 'nombre',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  nombre: string | null = null;

  @Column({
    name: 'shopify_cliente_id',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  shopifyClienteId: string | null = null;

  @Column({
    name: 'fecha_registro',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  fechaRegistro!: Date;

  @Column({
    name: 'fecha_creacion',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  fechaCreacion!: Date;

  @Column({
    name: 'fecha_actualizacion',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  fechaActualizacion!: Date;

  @Column({
    name: 'activo',
    type: 'boolean',
    default: true,
    nullable: false,
  })
  activo!: boolean;
}


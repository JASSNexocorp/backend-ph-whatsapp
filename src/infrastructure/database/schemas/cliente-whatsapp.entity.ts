
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WhatsAppConversacionEntity } from './whatsapp-conversation.entity';


/**
* Entidad TypeORM para CLIENTE_WHATSAPP.
* Representa al usuario identificado por su número de WhatsApp según el 
* esquema del módulo WhatsApp.
*/
@Entity({ name: 'CLIENTE_WHATSAPP' })
export class WhatsAppClienteEntity {
  @PrimaryGeneratedColumn({ name: 'id_cliente' })
  idCliente!: number;

  @Column({ name: 'numero_whatsapp', type: 'varchar', length: 20, unique: true })
  numeroWhatsapp!: string;

  @Column({ name: 'nombre', type: 'varchar', length: 100, nullable: true })
  nombre!: string | null;

  @Column({ name: 'email', type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ name: 'nit', type: 'varchar', length: 50, nullable: true })
  nit!: string | null;

  @Column({ name: 'razon_social', type: 'varchar', length: 100, nullable: true })
  razonSocial!: string | null;

  @Column({ name: 'shopify_cliente_id', type: 'varchar', length: 50, nullable: true })
  shopifyClienteId!: string | null;

  @Column({ name: 'fecha_registro', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  fechaRegistro!: Date;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  fechaCreacion!: Date;

  @UpdateDateColumn({ name: 'fecha_actualizacion', type: 'timestamp' })
  fechaActualizacion!: Date;

  @Column({ name: 'activo', type: 'boolean', default: true })
  activo!: boolean;

  @OneToOne(() => WhatsAppConversacionEntity, (c) => c.cliente)
  conversacion!: WhatsAppConversacionEntity;
}
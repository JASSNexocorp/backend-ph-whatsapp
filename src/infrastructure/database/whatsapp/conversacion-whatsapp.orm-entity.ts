import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Persistencia del estado activo del bot por cliente.
 * Guarde estado por `nodo_actual` y un JSONB `carrito` para datos temporales del flujo.
 */
@Entity({ name: 'CONVERSACION_WHATSAPP' })
@Index('idx_conversacion_cliente', ['idCliente'])
@Index('idx_conversacion_expira', ['expiraEn'])
@Index('idx_conversacion_nodo', ['nodoActual'])
@Index('idx_conversacion_activo', ['activo'])
export class ConversacionWhatsAppEntity {
  @PrimaryGeneratedColumn({ name: 'id_conversacion', type: 'int' })
  idConversacion!: number;

  @Column({ name: 'id_cliente', type: 'int', unique: true })
  idCliente!: number;

  @Column({
    name: 'tipo_flujo',
    type: 'varchar',
    length: 20,
    default: 'primera_compra',
  })
  tipoFlujo!: 'primera_compra' | 'segunda_compra';

  @Column({
    name: 'nodo_actual',
    type: 'varchar',
    length: 100,
    default: 'inicio',
  })
  nodoActual!: string;

  @Column({
    name: 'carrito',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  carrito!: unknown;

  @Column({
    name: 'ultima_actividad',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  ultimaActividad!: Date;

  @Column({
    name: 'expira_en',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP + INTERVAL \'2 hours\'',
  })
  expiraEn!: Date;

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


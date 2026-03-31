import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { WhatsAppClienteEntity } from "./cliente-whatsapp.entity";

/** JSONB definido en el esquema del modulo WhatsApp. */
export interface CarritoLinea {
    shopify_variante_id: string;
    shopify_producto_id: string;
    nombre: string;
    cantidad: number;
    precio_unitario: number;
    sucursal_id: string;
}

@Entity({ name : 'CONVERSACION_WHATSAPP' })
export class WhatsAppConversacionEntity {
    @PrimaryGeneratedColumn({ name: 'id_conversacion' })
    idConversacion: number;

    // Lado propietario de la relacion : La FK id_cliente vive en esta tabla.
    @OneToOne(() => WhatsAppClienteEntity, (cliente) => cliente.conversacion, {
        onDelete : 'CASCADE'
    })
    @JoinColumn({ name: 'id_cliente' , referencedColumnName : 'idCliente' })
    cliente: WhatsAppClienteEntity;

    @Column({
        name: 'tipo_flujo',
        type: 'varchar',
        length: 20,
        default: 'primera_compra'
    })
    tipoFlujo: 'primera_compra' | 'segunda_compra';

    @Column({ name : 'nodo_actual', type: 'varchar', length: 100, default: 'inicio' })
    nodoActual: string;

    @Column({
        name: 'carrito',
        type: 'jsonb',
        default: () => "'[]'::jsonb",
      })
    carrito: CarritoLinea[];

    @Column({
        name: 'ultima_actividad',
        type: 'timestamp',
        default: () => 'CURRENT_TIMESTAMP',
      })
    ultimaActividad: Date;

    @Column({
        name: 'expira_en',
        type: 'timestamp',
        default: () => "CURRENT_TIMESTAMP + INTERVAL '2 hours'",
      })
      expiraEn: Date;

    @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
    fechaCreacion: Date;

    @UpdateDateColumn({ name: 'fecha_actualizacion', type: 'timestamp' })
    fechaActualizacion: Date;
    
    @Column({ name: 'activo', type: 'boolean', default: true })
    activo: boolean;
}
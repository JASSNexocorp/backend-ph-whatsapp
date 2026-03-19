import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea las tablas del módulo WhatsApp siguiendo el esquema pactado.
 * Importante: no usar synchronize; esta migración debe ejecutarse manualmente.
 */
export class WhatsappSchemaMigration1690000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS CLIENTE_WHATSAPP (
        id_cliente SERIAL PRIMARY KEY,
        numero_whatsapp VARCHAR(20) NOT NULL UNIQUE,
        nombre VARCHAR(100),
        shopify_cliente_id VARCHAR(50),
        fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        CONSTRAINT chk_cliente_numero CHECK (numero_whatsapp ~ '^\\+?[0-9]{7,20}$')
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS CONVERSACION_WHATSAPP (
        id_conversacion SERIAL PRIMARY KEY,
        id_cliente INTEGER NOT NULL UNIQUE,
        tipo_flujo VARCHAR(20) NOT NULL DEFAULT 'primera_compra'
          CHECK (tipo_flujo IN ('primera_compra', 'segunda_compra')),
        nodo_actual VARCHAR(100) NOT NULL DEFAULT 'inicio',
        carrito JSONB NOT NULL DEFAULT '[]'::JSONB,
        ultima_actividad TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expira_en TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '2 hours'),
        fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        CONSTRAINT fk_conversacion_cliente
          FOREIGN KEY (id_cliente) REFERENCES CLIENTE_WHATSAPP(id_cliente)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cliente_whatsapp_numero
        ON CLIENTE_WHATSAPP (numero_whatsapp);
      CREATE INDEX IF NOT EXISTS idx_cliente_whatsapp_shopify
        ON CLIENTE_WHATSAPP (shopify_cliente_id);
      CREATE INDEX IF NOT EXISTS idx_cliente_whatsapp_activo
        ON CLIENTE_WHATSAPP (activo);

      CREATE INDEX IF NOT EXISTS idx_conversacion_cliente
        ON CONVERSACION_WHATSAPP (id_cliente);
      CREATE INDEX IF NOT EXISTS idx_conversacion_expira
        ON CONVERSACION_WHATSAPP (expira_en);
      CREATE INDEX IF NOT EXISTS idx_conversacion_nodo
        ON CONVERSACION_WHATSAPP (nodo_actual);
      CREATE INDEX IF NOT EXISTS idx_conversacion_activo
        ON CONVERSACION_WHATSAPP (activo);
      CREATE INDEX IF NOT EXISTS idx_conversacion_carrito
        ON CONVERSACION_WHATSAPP USING GIN (carrito);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS CONVERSACION_WHATSAPP;`);
    await queryRunner.query(`DROP TABLE IF EXISTS CLIENTE_WHATSAPP;`);
  }
}


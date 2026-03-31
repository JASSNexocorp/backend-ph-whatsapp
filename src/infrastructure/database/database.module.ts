import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { WhatsAppClienteEntity } from "./schemas/cliente-whatsapp.entity";
import { WhatsAppConversacionEntity } from "./schemas/whatsapp-conversation.entity";


/**
 * Registra TypeORM contra Postgres y expone los repositorios de las entidades WhatsApp
 * Centraliza la conexion para que el webhook y los casos de uso compartan la misma BD.
 */
@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                type: 'postgres',
                host: config.getOrThrow<string>('DB_HOST'),
                port: Number(config.getOrThrow<string>('DB_PORT')),
                username: config.getOrThrow<string>('DB_USERNAME'),
                password: config.getOrThrow<string>('DB_PASSWORD'),
                database: config.getOrThrow<string>('DB_NAME'),
                entities: [WhatsAppClienteEntity, WhatsAppConversacionEntity],
                // Solo para desarrollo : en produccion usar migraciones y sincronizacion manual.
                synchronize: config.getOrThrow<string>('NODE_ENV') === 'development',
            })
        })
        ,TypeOrmModule.forFeature([WhatsAppClienteEntity, WhatsAppConversacionEntity])
    ],
    exports: [TypeOrmModule]
})
export class DatabaseModule {}
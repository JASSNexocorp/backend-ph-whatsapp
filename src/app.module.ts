import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppWebhookController } from './adapters/controllers/whatsapp-webhook.controller';
import { WhatsAppMenuScraperService } from './adapters/external-services/whatsapp-menu-scraper.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as path from 'path';
import { ClienteWhatsAppEntity } from './infrastructure/database/whatsapp/cliente-whatsapp.orm-entity';
import {
  ConversacionWhatsAppEntity,
} from './infrastructure/database/whatsapp/conversacion-whatsapp.orm-entity';
import { WhatsAppFlowService } from './adapters/services/whatsapp-flow.service';
import { ClienteWhatsappRepositoryPostgres } from './adapters/repositories/cliente-whatsapp.repository.postgres';
import { ConversacionWhatsappRepositoryPostgres } from './adapters/repositories/conversacion-whatsapp.repository.postgres';
import { WhatsAppSenderService } from './adapters/external-services/whatsapp-sender.adapter';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [ClienteWhatsAppEntity, ConversacionWhatsAppEntity],
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrations: [
        path.join(__dirname, 'infrastructure/database/migrations/*{.ts,.js}'),
      ],
    }),
  ],
  controllers: [AppController, WhatsAppWebhookController],
  providers: [
    AppService,
    WhatsAppMenuScraperService,
    WhatsAppSenderService,
    WhatsAppFlowService,
    ClienteWhatsappRepositoryPostgres,
    ConversacionWhatsappRepositoryPostgres,
  ],
})
export class AppModule {}

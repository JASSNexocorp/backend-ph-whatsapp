import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: el front (p. ej. Angular en :4200) llama al API en otro puerto; sin esto el preflight OPTIONS devuelve 404.
  const rawOrigenes = process.env.ALLOWED_ORIGINS?.trim();
  const origenes =
    rawOrigenes && rawOrigenes.length > 0
      ? rawOrigenes.split(',').map((o) => o.trim()).filter(Boolean)
      : ['http://localhost:4200'];
  app.enableCors({
    origin: origenes,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: el front (Netlify y/o Angular en :4200) llama al API en otro host/puerto.
  // const rawOrigenes = process.env.ALLOWED_ORIGINS?.trim();
  // const origenes =
  //   rawOrigenes && rawOrigenes.length > 0
  //     ? rawOrigenes.split(',').map((o) => o.trim()).filter(Boolean)
  //     : [
  //         'https://famous-melomakarona-c4e4cf.netlify.app',
  //         'http://localhost:4200',
  //       ];
  // app.enableCors({
  //   origin: origenes,
  //   methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  //   credentials: true,
  //   // ngrok-free: el front debe enviar esta cabecera; el preflight debe listarla en Allow-Headers.
  //   allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  // });
  app.enableCors();

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
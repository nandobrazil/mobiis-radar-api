import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['https://mobiis-radar.oconde.dev', 'http://localhost:4200'],
  });
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('mobiis-radar')
    .setDescription('API de radar de churn — identifica clientes em risco e gera análise via Claude AI')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(3000);
  console.log('mobiis-radar rodando em http://localhost:3000');
  console.log('Swagger disponível em http://localhost:3000/docs');
}
bootstrap();

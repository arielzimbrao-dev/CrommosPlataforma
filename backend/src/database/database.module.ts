import { Module } from '@nestjs/common';
import { databaseProviders } from './database.providers';

/** DATA_SOURCE + um repositório por entidade (ver database.providers.ts). */
@Module({
  providers: [...databaseProviders],
  exports: [...databaseProviders],
})
export class DatabaseModule {}

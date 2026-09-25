import { Global, Module } from '@nestjs/common';
import { criarEmailProvider, EMAIL_PROVIDER } from './email.provider';
import { MailService } from './mail.service';

@Global()
@Module({
  providers: [
    MailService,
    { provide: EMAIL_PROVIDER, useFactory: () => criarEmailProvider() },
  ],
  exports: [MailService],
})
export class MailModule {}

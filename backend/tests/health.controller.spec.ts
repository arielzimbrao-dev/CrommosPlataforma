import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from 'src/common/health/health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns ok status for the plataforma-api service (no DB dependency)', () => {
    expect(controller.getHealth()).toEqual({
      status: 'ok',
      service: 'plataforma-api',
    });
  });
});

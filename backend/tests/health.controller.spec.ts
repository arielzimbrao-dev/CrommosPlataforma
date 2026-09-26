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

  it('ready: SELECT 1 no banco → ok; falha ou sem banco → 503', async () => {
    const ds = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const c = new HealthController(ds as never);
    await expect(c.ready()).resolves.toEqual({ status: 'ok', banco: 'ok' });
    ds.query.mockRejectedValue(new Error('down'));
    await expect(c.ready()).rejects.toThrow('Banco indisponível.');
    await expect(new HealthController().ready()).rejects.toThrow();
  });

  it('returns ok status for the plataforma-api service (no DB dependency)', () => {
    expect(controller.getHealth()).toEqual({
      status: 'ok',
      service: 'plataforma-api',
    });
  });
});

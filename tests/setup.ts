// Jest setup file for global mocks
import { jest } from '@jest/globals';

// Mock mongoose globally to prevent connection attempts
jest.mock('mongoose', () => ({
  connect: (jest.fn() as any).mockResolvedValue(undefined),
  connection: {
    close: (jest.fn() as any).mockResolvedValue(undefined),
    on: jest.fn(),
    once: jest.fn(),
  },
  model: jest.fn(),
  Schema: class Schema {
    static Types: any = {
      ObjectId: 'ObjectId',
      String: 'String',
      Number: 'Number',
      Date: 'Date',
      Mixed: 'Mixed',
      Array: 'Array',
      Boolean: 'Boolean',
    };
    constructor() {}
  },
}));

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.RABBITMQ_URL = 'amqp://localhost:5672';
  process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
});

afterAll(() => {
  // Cleanup if needed
  jest.clearAllMocks();
});

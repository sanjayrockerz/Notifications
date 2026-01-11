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
  model: (jest.fn() as any).mockReturnValue({
    find: (jest.fn() as any).mockReturnThis(),
    findOne: (jest.fn() as any).mockReturnThis(),
    findById: (jest.fn() as any).mockReturnThis(),
    create: (jest.fn() as any).mockResolvedValue({}),
    updateOne: (jest.fn() as any).mockResolvedValue({}),
    deleteOne: (jest.fn() as any).mockResolvedValue({}),
    countDocuments: (jest.fn() as any).mockResolvedValue(0),
  }),
  Schema: class MockSchema {
    static Types: any = {
      ObjectId: 'ObjectId',
      String: 'String',
      Number: 'Number',
      Date: 'Date',
      Mixed: 'Mixed',
      Array: 'Array',
      Boolean: 'Boolean',
    };
    index() { return this; }
    pre() { return this; }
    post() { return this; }
    methods: any = {};
    statics: any = {};
    constructor() {}
  },
  startSession: (jest.fn() as any).mockResolvedValue({
    startTransaction: jest.fn(),
    commitTransaction: (jest.fn() as any).mockResolvedValue(undefined),
    abortTransaction: (jest.fn() as any).mockResolvedValue(undefined),
    endSession: (jest.fn() as any).mockResolvedValue(undefined),
  }),
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

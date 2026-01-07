// Integration test: Follow → Notification
// This test assumes a running Notification service and a test DB (use a test DB or mock DB connection)
// It simulates a follow event and checks DB for notification and delivery log


import request from 'supertest';
import mongoose from 'mongoose';
import NotificationServer from '../src/server';
import Notification from '../src/models/Notification';
import DeliveryLog from '../src/models/DeliveryLog';

const TEST_USER_ID = 'user-2';
const TEST_FOLLOWER_ID = 'user-1';

// Helper: Wait for event propagation
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('Integration: Follow event creates notification', () => {
  beforeAll(async () => {
    // Connect to test DB
    await mongoose.connect(process.env.TEST_DB_URI || '', { dbName: 'notifications_test' });
    await Notification.deleteMany({ userId: TEST_USER_ID });
    await DeliveryLog.deleteMany({ userId: TEST_USER_ID });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('should create notification and delivery log on follow', async () => {
    // Simulate follow event (call Feature service or publish event directly)
    const server = new NotificationServer();
    await server.initialize();
    await request(server.getApp())
      .post('/feature/follow')
      .send({ followerId: TEST_FOLLOWER_ID, followedId: TEST_USER_ID })
      .expect(200);

    await wait(1000); // Wait for event propagation

    const notif = await Notification.findOne({ userId: TEST_USER_ID, type: 'UserFollowed' });
    expect(notif).toBeTruthy();

    const logs = await DeliveryLog.find({ notificationId: notif?._id });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: any) => l.status === 'pending')).toBe(true);
  });
});

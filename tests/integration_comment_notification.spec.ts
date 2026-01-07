// Integration test: Comment → Notification
// Simulates a comment event and checks DB for notification and delivery log

import request from 'supertest';
import mongoose from 'mongoose';
import NotificationServer from '../src/server';
import Notification from '../src/models/Notification';
import DeliveryLog from '../src/models/DeliveryLog';

const TEST_POST_OWNER_ID = 'user-2';
const TEST_COMMENTER_ID = 'user-3';
const TEST_POST_ID = 'post-1';

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('Integration: CommentCreated event creates notification', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.TEST_DB_URI || '', { dbName: 'notifications_test' });
    await Notification.deleteMany({ userId: TEST_POST_OWNER_ID });
    await DeliveryLog.deleteMany({ userId: TEST_POST_OWNER_ID });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('should create notification and delivery log on comment', async () => {
    const server = new NotificationServer();
    await server.initialize();
    await request(server.getApp())
      .post('/feature/comment')
      .send({ commenterId: TEST_COMMENTER_ID, postId: TEST_POST_ID, postOwnerId: TEST_POST_OWNER_ID, commentText: 'Nice post!', actionUrl: 'https://app/posts/post-1' })
      .expect(200);

    await wait(1000);

    const notif = await Notification.findOne({ userId: TEST_POST_OWNER_ID, type: 'comment' });
    expect(notif).toBeTruthy();

    const logs = await DeliveryLog.find({ notificationId: notif?._id });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: any) => l.status === 'pending')).toBe(true);
  });
});

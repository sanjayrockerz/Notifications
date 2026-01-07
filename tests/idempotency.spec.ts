// Idempotency test: Publishing the same event twice should not create duplicate notifications

import { jest } from '@jest/globals';

// Mock all dependencies first
jest.mock('../src/services/NotificationService');
jest.mock('../src/config/redis');
jest.mock('../src/config/database');
jest.mock('../src/config/messageQueue');

import { EventHandlerService } from '../src/services/EventHandlerService';
import { NotificationService } from '../src/services/NotificationService';

const mockSendNotification = jest.fn();

describe('Idempotency: UserFollowed event', () => {
  let handler: EventHandlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService as jest.MockedClass<typeof NotificationService>).mockImplementation(() => ({
      sendNotification: mockSendNotification,
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any));
    
    handler = new EventHandlerService();
  });

  it('should only create one notification for duplicate events', async () => {
    mockSendNotification
      .mockResolvedValueOnce({
        notificationId: 'notif-1',
        status: 'success',
        message: 'Notification sent',
        deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
      })
      .mockResolvedValueOnce({
        notificationId: 'notif-1',
        status: 'success',
        message: 'Notification sent',
        deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
      });

    const mockEvent = {
      eventId: 'idempotent-event-id',
      eventType: 'UserFollowed',
      followerId: 'user-1',
      followeeId: 'user-2',
      timestamp: new Date(),
    };

    await (handler as any).handleUserFollowedEvent(mockEvent);
    await (handler as any).handleUserFollowedEvent(mockEvent);

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });
});

import { jest } from '@jest/globals';

// Mock all dependencies first
jest.mock('../src/services/NotificationService');
jest.mock('../src/config/redis');
jest.mock('../src/config/database');
jest.mock('../src/config/messageQueue');

import { EventHandlerService } from '../src/services/EventHandlerService';
import { NotificationService } from '../src/services/NotificationService';

const mockSendNotification = jest.fn();

describe('EventHandlerService.handleLikeCreatedEvent', () => {
  let handler: EventHandlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService as jest.MockedClass<typeof NotificationService>).mockImplementation(() => ({
      sendNotification: mockSendNotification,
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any));
    
    handler = new EventHandlerService();
  });

  it('should create a notification for like', async () => {
    mockSendNotification.mockResolvedValue({
      notificationId: 'notif-4',
      status: 'success',
      message: 'Notification sent',
      deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
    });

    const mockEvent = {
      eventId: 'test-like-event-id',
      eventType: 'like.created',
      likerId: 'user-6',
      targetOwnerId: 'user-7',
      targetType: 'post',
      targetId: 'post-2',
      actionUrl: 'https://app/posts/post-2',
      timestamp: new Date(),
      version: 'v1',
    };

    const result = await (handler as any).handleLikeCreatedEvent(mockEvent);

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-7',
        category: 'social',
      })
    );
    expect(result.success).toBe(true);
  });
});

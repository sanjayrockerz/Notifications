import { jest } from '@jest/globals';

// Mock all dependencies first
jest.mock('../src/services/NotificationService');
jest.mock('../src/config/redis');
jest.mock('../src/config/database');
jest.mock('../src/config/messageQueue');

import { EventHandlerService } from '../src/services/EventHandlerService';
import { NotificationService } from '../src/services/NotificationService';

const mockSendNotification = jest.fn();

describe('EventHandlerService.handleCommentCreatedEvent', () => {
  let handler: EventHandlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService as jest.MockedClass<typeof NotificationService>).mockImplementation(() => ({
      sendNotification: mockSendNotification,
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any));
    
    handler = new EventHandlerService();
  });

  it('should create a notification for comment', async () => {
    mockSendNotification.mockResolvedValue({
      notificationId: 'notif-2',
      status: 'success',
      message: 'Notification sent',
      deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
    });

    const mockEvent = {
      eventId: 'test-comment-event-id',
      eventType: 'comment.created',
      commenterId: 'user-3',
      postId: 'post-1',
      postOwnerId: 'user-2',
      commentText: 'Nice post!',
      actionUrl: 'https://app/posts/post-1',
      timestamp: new Date(),
      version: 'v1',
    };

    const result = await (handler as any).handleCommentCreatedEvent(mockEvent);

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        category: 'social',
      })
    );
    expect(result.success).toBe(true);
  });
});

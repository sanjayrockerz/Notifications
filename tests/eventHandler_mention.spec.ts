import { jest } from '@jest/globals';

// Mock all dependencies first
jest.mock('../src/services/NotificationService');
jest.mock('../src/config/redis');
jest.mock('../src/config/database');
jest.mock('../src/config/messageQueue');

import { EventHandlerService } from '../src/services/EventHandlerService';
import { NotificationService } from '../src/services/NotificationService';

const mockSendNotification = jest.fn();

describe('EventHandlerService.handleMentionCreatedEvent', () => {
  let handler: EventHandlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService as jest.MockedClass<typeof NotificationService>).mockImplementation(() => ({
      sendNotification: mockSendNotification,
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any));
    
    handler = new EventHandlerService();
  });

  it('should create a notification for mention', async () => {
    mockSendNotification.mockResolvedValue({
      notificationId: 'notif-3',
      status: 'success',
      message: 'Notification sent',
      deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
    });

    const mockEvent = {
      eventId: 'test-mention-event-id',
      eventType: 'mention.created',
      mentionerId: 'user-4',
      mentionedUserId: 'user-5',
      contextType: 'comment',
      contextId: 'comment-1',
      mentionText: '@user5 check this out!',
      actionUrl: 'https://app/posts/post-1',
      timestamp: new Date(),
      version: 'v1',
    };

    const result = await (handler as any).handleMentionCreatedEvent(mockEvent);

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-5',
        category: 'social',
      })
    );
    expect(result.success).toBe(true);
  });
});


import { EventHandlerService } from '../src/services/EventHandlerService';
import { NotificationService } from '../src/services/NotificationService';
import { jest } from '@jest/globals';

// Mock dependencies
jest.mock('../src/services/NotificationService');
jest.mock('../src/config/redis');
jest.mock('../src/config/database');
jest.mock('../src/config/messageQueue');

const mockSendNotification = jest.fn();

describe('EventHandlerService.handleUserFollowedEvent', () => {
  let handler: EventHandlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService as jest.MockedClass<typeof NotificationService>).mockImplementation(() => ({
      sendNotification: mockSendNotification,
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any));
    
    handler = new EventHandlerService();
  });

  it('should create a notification via NotificationService', async () => {
    mockSendNotification.mockResolvedValue({
      notificationId: 'notif-1',
      status: 'success',
      message: 'Notification sent',
      deliveryDetails: { totalDevices: 1, successCount: 1, failureCount: 0 },
    });

    const mockEvent = {
      eventId: 'test-event-id',
      eventType: 'UserFollowed',
      followerId: 'user-1',
      followeeId: 'user-2',
      timestamp: new Date(),
    };

    const result = await (handler as any).handleUserFollowedEvent(mockEvent);

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        category: 'social',
      })
    );
    expect(result.success).toBe(true);
  });

  it('should handle failures gracefully', async () => {
    mockSendNotification.mockResolvedValue({
      notificationId: 'notif-1',
      status: 'failed',
      message: 'No devices found',
      deliveryDetails: { totalDevices: 0, successCount: 0, failureCount: 0 },
    });

    const mockEvent = {
      eventId: 'test-event-id',
      eventType: 'UserFollowed',
      followerId: 'user-1',
      followeeId: 'user-2',
      timestamp: new Date(),
    };

    const result = await (handler as any).handleUserFollowedEvent(mockEvent);
    expect(result.success).toBe(false);
  });
});

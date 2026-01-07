import { Application, Request, Response } from 'express';
import DeviceController from './controllers/DeviceController';
import NotificationController from './controllers/NotificationController';
import PreferencesController from './controllers/PreferencesController';

export function setupDeviceRoutes(app: Application) {
  app.post('/devices/register', DeviceController.registerDevice);
  app.post('/devices/refresh', DeviceController.refreshDevice);
  app.delete('/devices/:deviceId', DeviceController.deleteDevice);
}

export function setupPreferencesRoutes(app: Application) {
  app.get('/users/:userId/notification-preferences', PreferencesController.getPreferences);
  app.post('/users/:userId/notification-preferences', PreferencesController.updatePreferences);
  app.put('/users/:userId/notification-preferences/bulk', PreferencesController.updateBulkPreferences);
}

export function setupRoutes(app: Application) {
  setupDeviceRoutes(app);
  setupPreferencesRoutes(app);
  // Notification inbox sync APIs
  app.get('/notifications', NotificationController.getNotifications);
  app.get('/notifications/unread-count', NotificationController.getUnreadCount);
  app.post('/notifications/:notificationId/read', NotificationController.markAsRead);
  app.post('/notifications/read-batch', NotificationController.markBatchAsRead);
}

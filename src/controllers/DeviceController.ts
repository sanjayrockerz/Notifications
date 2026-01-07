import { Request, Response } from 'express';
import Joi from 'joi';
import Device from '../models/Device';
import Notification from '../models/Notification';
import { commonSchemas } from '../utils/validation';

const deviceIdSchema = Joi.alternatives().try(
  Joi.string().uuid(),
  Joi.string().alphanum().min(8).max(128)
);
const fcmTokenSchema = Joi.string().pattern(/^[A-Za-z0-9\-_:.]+$/).min(100).max(200);

export default {
  async registerDevice(req: Request, res: Response) {
    const schema = Joi.object({
      userId: commonSchemas.userId,
      deviceId: deviceIdSchema.required(),
      platform: Joi.string().valid('android', 'ios').required(),
      fcmToken: fcmTokenSchema.required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.message });

    const { userId, deviceId, platform, fcmToken } = value;
    const now = new Date();
    let device = await Device.findOne({ deviceToken: deviceId });
    if (device) {
      (device as any).fcmToken = fcmToken;
      (device as any).platform = platform;
      (device as any).isActive = true;
      (device as any).lastSeen = now;
      await device.save();
    } else {
      device = await Device.create({
        userId,
        deviceToken: deviceId,
        platform,
        isActive: true,
        lastSeen: now,
        registrationDate: now,
        fcmToken,
      });
    }
    // Get unread count
    const unreadCount = await Notification.countDocuments({ userId, read: false });
    return res.json({ deviceId, unreadCount, success: true });
  },

  async refreshDevice(req: Request, res: Response) {
    const schema = Joi.object({
      deviceId: deviceIdSchema.required(),
      fcmToken: fcmTokenSchema.optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.message });
    const { deviceId, fcmToken } = value;
    const device = await Device.findOne({ deviceToken: deviceId });
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    device.lastSeen = new Date();
    device.isActive = true;
    if (fcmToken) (device as any).fcmToken = fcmToken;
    await device.save();
    return res.json({ success: true });
  },

  async deleteDevice(req: Request, res: Response) {
    const { deviceId } = req.params;
    const { error } = deviceIdSchema.validate(deviceId);
    if (error) return res.status(400).json({ success: false, error: error.message });
    const device = await Device.findOne({ deviceToken: deviceId });
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    device.isActive = false;
    await device.save();
    return res.json({ success: true });
  },
};

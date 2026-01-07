-- Migration: Add notification preferences and quiet hours support
-- Date: 2026-01-06
-- Description: Extends user_preferences and notifications tables with new fields

-- Add notification type preferences to user_preferences
-- Note: This uses JSONB for flexible key-value storage
ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS notification_types JSONB DEFAULT '{
  "follow": {"isEnabled": true},
  "like": {"isEnabled": true},
  "comment": {"isEnabled": true},
  "mention": {"isEnabled": true},
  "message": {"isEnabled": true}
}'::jsonb;

-- Add quiet hours configuration to user_preferences
ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN DEFAULT false;

ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS quiet_hours_start VARCHAR(5) DEFAULT '22:00';

ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS quiet_hours_end VARCHAR(5) DEFAULT '09:00';

ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS quiet_hours_timezone VARCHAR(50) DEFAULT 'UTC';

-- Add urgent flag to notifications table
ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS urgent BOOLEAN DEFAULT false;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_preferences_notification_types 
ON user_preferences USING gin(notification_types);

CREATE INDEX IF NOT EXISTS idx_user_preferences_quiet_hours 
ON user_preferences (user_id, quiet_hours_enabled) 
WHERE quiet_hours_enabled = true;

CREATE INDEX IF NOT EXISTS idx_notifications_urgent 
ON notifications (urgent, status, created_at) 
WHERE urgent = true;

-- Add comments for documentation
COMMENT ON COLUMN user_preferences.notification_types IS 
'JSON object storing enabled/disabled state for each notification type (follow, like, comment, mention, message)';

COMMENT ON COLUMN user_preferences.quiet_hours_enabled IS 
'Whether quiet hours feature is enabled for this user';

COMMENT ON COLUMN user_preferences.quiet_hours_start IS 
'Start time of quiet hours in HH:MM format (24-hour)';

COMMENT ON COLUMN user_preferences.quiet_hours_end IS 
'End time of quiet hours in HH:MM format (24-hour)';

COMMENT ON COLUMN user_preferences.quiet_hours_timezone IS 
'IANA timezone identifier for user (e.g., America/New_York, Europe/London)';

COMMENT ON COLUMN notifications.urgent IS 
'If true, notification bypasses quiet hours and delivers immediately';

-- Example queries for testing:

-- Get users with quiet hours enabled
-- SELECT user_id, quiet_hours_start, quiet_hours_end, quiet_hours_timezone 
-- FROM user_preferences 
-- WHERE quiet_hours_enabled = true;

-- Get users who have disabled specific notification types
-- SELECT user_id, notification_types 
-- FROM user_preferences 
-- WHERE notification_types->>'follow' = '{"isEnabled": false}';

-- Get urgent notifications pending delivery
-- SELECT notification_id, user_id, title, urgent, status 
-- FROM notifications 
-- WHERE urgent = true AND status = 'pending';

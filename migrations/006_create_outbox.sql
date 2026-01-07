-- Transactional Outbox Table
-- Ensures at-least-once delivery by persisting events before publishing
-- Part of the outbox pattern for reliable event publishing

CREATE TABLE IF NOT EXISTS outbox (
  id VARCHAR(36) PRIMARY KEY,
  event_id VARCHAR(36) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  payload JSON NOT NULL,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP NULL,
  retry_count INT DEFAULT 0,
  last_error TEXT NULL,
  INDEX idx_published_created (published, created_at),
  INDEX idx_event_type (event_type),
  INDEX idx_published_at (published_at)
);

-- Add composite unique constraints to notifications for idempotency
-- Prevents duplicate notifications for the same event
ALTER TABLE notifications 
ADD CONSTRAINT unique_user_follow_notification 
UNIQUE (user_id, category, source, metadata);

-- Note: The above constraint uses metadata to store resourceId
-- In practice, you might want a dedicated resource_id column:
-- ALTER TABLE notifications ADD COLUMN resource_id VARCHAR(100);
-- ALTER TABLE notifications ADD CONSTRAINT unique_user_resource_notification 
-- UNIQUE (user_id, category, resource_id);

-- Create index for faster duplicate checking
CREATE INDEX idx_notifications_dedup 
ON notifications(user_id, category, source, created_at DESC);

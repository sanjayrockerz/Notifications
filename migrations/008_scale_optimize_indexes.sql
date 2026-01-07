-- Migration 008: Phase 5 - Scale & Optimize
-- Adds indexes for performance and creates archive tables
-- Date: 2024-01-15

-- =====================================================
-- 1. Add Performance Indexes to notifications table
-- =====================================================

-- Optimized index for fetching unread notifications (most common query)
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created 
ON notifications(user_id, is_read, created_at DESC)
WHERE is_read = false;

-- Optimized index for fetching all notifications by user
CREATE INDEX IF NOT EXISTS idx_notifications_user_created 
ON notifications(user_id, created_at DESC);

-- Index for retry processing
CREATE INDEX IF NOT EXISTS idx_notifications_status_retry 
ON notifications(status, next_retry_at)
WHERE status IN ('failed', 'pending');

-- Index for scheduled notifications
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled 
ON notifications(schedule_at, status)
WHERE schedule_at IS NOT NULL AND status = 'scheduled';

-- Index for notification category analytics
CREATE INDEX IF NOT EXISTS idx_notifications_category_created 
ON notifications(category, created_at DESC);

-- Composite index for preference-based filtering
CREATE INDEX IF NOT EXISTS idx_notifications_user_category_source 
ON notifications(user_id, category, source, created_at DESC);

-- =====================================================
-- 2. Create notifications_archive table
-- =====================================================

CREATE TABLE IF NOT EXISTS notifications_archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id VARCHAR(255) UNIQUE NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  title VARCHAR(100) NOT NULL,
  body VARCHAR(500) NOT NULL,
  data JSONB DEFAULT '{}',
  image_url TEXT,
  icon_url TEXT,
  priority VARCHAR(20) DEFAULT 'normal',
  category VARCHAR(50) NOT NULL,
  tags TEXT[],
  urgent BOOLEAN DEFAULT false,
  schedule_at TIMESTAMP WITH TIME ZONE,
  timezone VARCHAR(50),
  status VARCHAR(20) DEFAULT 'pending',
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMP WITH TIME ZONE,
  delivery JSONB DEFAULT '{"attempts": 0, "devices": []}',
  interactions JSONB DEFAULT '[]',
  expires_at TIMESTAMP WITH TIME ZONE,
  source VARCHAR(100) NOT NULL,
  campaign VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  resource_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for archive table (minimal for performance, mainly for restore operations)
CREATE INDEX IF NOT EXISTS idx_notifications_archive_user 
ON notifications_archive(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_archive_notification_id 
ON notifications_archive(notification_id);

CREATE INDEX IF NOT EXISTS idx_notifications_archive_created 
ON notifications_archive(created_at DESC);

-- =====================================================
-- 3. Create group_notifications_archive table
-- =====================================================

CREATE TABLE IF NOT EXISTS group_notifications_archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_notification_id VARCHAR(255) UNIQUE NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  actor_user_id VARCHAR(255) NOT NULL,
  actor_username VARCHAR(100),
  actor_avatar_url TEXT,
  actor_follower_count INTEGER DEFAULT 0,
  title VARCHAR(100) NOT NULL,
  body VARCHAR(500) NOT NULL,
  data JSONB DEFAULT '{}',
  target_audience VARCHAR(50) DEFAULT 'followers',
  target_user_ids TEXT[],
  exclude_user_ids TEXT[],
  push_strategy VARCHAR(20) DEFAULT 'none',
  firebase_topic VARCHAR(255),
  priority VARCHAR(20) DEFAULT 'normal',
  estimated_reach INTEGER DEFAULT 0,
  actual_reach INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  action_url TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for group notifications archive
CREATE INDEX IF NOT EXISTS idx_group_notifications_archive_actor 
ON group_notifications_archive(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_notifications_archive_group_id 
ON group_notifications_archive(group_notification_id);

CREATE INDEX IF NOT EXISTS idx_group_notifications_archive_created 
ON group_notifications_archive(created_at DESC);

-- =====================================================
-- 4. Add indexes to group_notifications table
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_group_notifications_actor_created 
ON group_notifications(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_notifications_active_created 
ON group_notifications(is_active, created_at DESC)
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_group_notifications_event_type 
ON group_notifications(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_notifications_firebase_topic 
ON group_notifications(firebase_topic)
WHERE firebase_topic IS NOT NULL;

-- =====================================================
-- 5. Add indexes to device_tokens table (if not exists)
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active 
ON device_tokens(user_id, is_active)
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_device_tokens_last_used 
ON device_tokens(last_used_at DESC);

-- =====================================================
-- 6. Add indexes to user_preferences table
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id 
ON user_preferences(user_id);

CREATE INDEX IF NOT EXISTS idx_user_preferences_updated 
ON user_preferences(updated_at DESC);

-- =====================================================
-- 7. Analyze tables for query planner
-- =====================================================

ANALYZE notifications;
ANALYZE notifications_archive;
ANALYZE group_notifications;
ANALYZE group_notifications_archive;
ANALYZE device_tokens;
ANALYZE user_preferences;

-- =====================================================
-- 8. Create function to auto-archive old notifications (optional trigger)
-- =====================================================

CREATE OR REPLACE FUNCTION archive_old_notifications()
RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  -- Move notifications older than 30 days to archive
  WITH moved AS (
    INSERT INTO notifications_archive
    SELECT * FROM notifications
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO archived_count FROM moved;

  -- Delete archived notifications from live table
  DELETE FROM notifications
  WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- Create function to archive old group notifications
CREATE OR REPLACE FUNCTION archive_old_group_notifications()
RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  -- Move inactive group notifications older than 30 days to archive
  WITH moved AS (
    INSERT INTO group_notifications_archive
    SELECT * FROM group_notifications
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
      AND is_active = false
    RETURNING id
  )
  SELECT COUNT(*) INTO archived_count FROM moved;

  -- Delete archived group notifications from live table
  DELETE FROM group_notifications
  WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
    AND is_active = false;

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 9. Create maintenance functions
-- =====================================================

-- Function to get table statistics
CREATE OR REPLACE FUNCTION get_notifications_stats()
RETURNS TABLE (
  table_name TEXT,
  row_count BIGINT,
  total_size TEXT,
  oldest_record TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    'notifications'::TEXT,
    COUNT(*)::BIGINT,
    pg_size_pretty(pg_total_relation_size('notifications')),
    MIN(created_at)
  FROM notifications
  UNION ALL
  SELECT 
    'notifications_archive'::TEXT,
    COUNT(*)::BIGINT,
    pg_size_pretty(pg_total_relation_size('notifications_archive')),
    MIN(created_at)
  FROM notifications_archive
  UNION ALL
  SELECT 
    'group_notifications'::TEXT,
    COUNT(*)::BIGINT,
    pg_size_pretty(pg_total_relation_size('group_notifications')),
    MIN(created_at)
  FROM group_notifications
  UNION ALL
  SELECT 
    'group_notifications_archive'::TEXT,
    COUNT(*)::BIGINT,
    pg_size_pretty(pg_total_relation_size('group_notifications_archive')),
    MIN(created_at)
  FROM group_notifications_archive;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 10. Add comments for documentation
-- =====================================================

COMMENT ON TABLE notifications_archive IS 'Archive table for notifications older than 30 days';
COMMENT ON TABLE group_notifications_archive IS 'Archive table for inactive group notifications older than 30 days';
COMMENT ON FUNCTION archive_old_notifications() IS 'Moves notifications older than 30 days to archive table';
COMMENT ON FUNCTION archive_old_group_notifications() IS 'Moves inactive group notifications older than 30 days to archive table';
COMMENT ON FUNCTION get_notifications_stats() IS 'Returns row counts and sizes for live and archive tables';

-- =====================================================
-- Migration Complete
-- =====================================================

-- Query to verify indexes were created:
-- SELECT tablename, indexname FROM pg_indexes WHERE tablename IN ('notifications', 'group_notifications', 'device_tokens', 'user_preferences') ORDER BY tablename, indexname;

-- Query to check table stats:
-- SELECT * FROM get_notifications_stats();

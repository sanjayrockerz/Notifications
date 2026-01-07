-- 005_create_notification_preferences.sql
CREATE TABLE notification_preferences (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    notification_type VARCHAR(32) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    max_per_hour INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user_pref FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_notification_preferences_user_type ON notification_preferences (user_id, notification_type);

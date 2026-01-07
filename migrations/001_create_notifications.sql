-- 001_create_notifications.sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('follow', 'comment', 'mention', 'like')),
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    data JSONB,
    read_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_notifications_user_createdat ON notifications (user_id, created_at DESC);

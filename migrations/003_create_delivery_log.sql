-- 003_create_delivery_log.sql
CREATE TABLE delivery_log (
    id UUID PRIMARY KEY,
    notification_id UUID NOT NULL,
    device_id UUID NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'invalid_token')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMP,
    sent_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_notification FOREIGN KEY(notification_id) REFERENCES notifications(id),
    CONSTRAINT fk_device FOREIGN KEY(device_id) REFERENCES device_tokens(id)
);

CREATE INDEX idx_delivery_log_status_retry ON delivery_log (status, next_retry_at);

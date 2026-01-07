-- 002_create_device_tokens.sql
CREATE TABLE device_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    device_id VARCHAR(128) NOT NULL UNIQUE,
    platform VARCHAR(16) NOT NULL CHECK (platform IN ('ios', 'android')),
    fcm_token VARCHAR(512) NOT NULL,
    last_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_user_device FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_device_tokens_user_active ON device_tokens (user_id, is_active);

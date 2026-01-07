-- 004_create_processed_events.sql
CREATE TABLE processed_events (
    id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL,
    user_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user_processed FOREIGN KEY(user_id) REFERENCES users(id),
    CONSTRAINT unique_event_user UNIQUE (event_id, user_id)
);

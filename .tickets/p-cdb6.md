---
id: p-cdb6
status: closed
deps: []
links: []
created: 2026-02-17T10:32:23Z
type: task
priority: 2
assignee: totalrecall-pubsub
tags: [team]
---
# ## Build TotalRecall Pub/Sub Subscriptions System

Working directory: /Users/alexander/Projects/totalrecall-rs

You're building a reactive pub/sub memory system for TotalRecall. Agents can subscribe to nodes/entities/topics and get notified when related new nodes are created.

### What to build:

#### 1. Database Migration (migrations/postgres/009_subscriptions.sql)

Two new tables:

```sql
-- Subscriptions: what agents are watching
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber TEXT NOT NULL,  -- agent/session identifier
    watch_type TEXT NOT NULL CHECK (watch_type IN ('node', 'entity', 'topic')),
    watch_target TEXT NOT NULL,  -- node UUID, entity name, or search query
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    last_checked BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Notifications: new related nodes for subscribers
CREATE TABLE IF NOT EXISTS subscription_notifications (
    id BIGSERIAL PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    triggered_by_node_id UUID NOT NULL REFERENCES synthesis_nodes(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,  -- why this notification was created
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber);
CREATE INDEX IF NOT EXISTS idx_subscriptions_watch ON subscriptions(watch_type, watch_target);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_subscription ON subscription_notifications(subscription_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON subscription_notifications(read) WHERE read = FALSE;
```

#### 2. Schema types (add to src/schema/mod.rs or wherever SynthesisNode etc are defined)

Add `Subscription` and `SubscriptionNotification` structs.

#### 3. DB Trait: SubscriptionOps (add to src/db/traits.rs)

```rust
#[async_trait]
pub trait SubscriptionOps: Send + Sync {
    async fn create_subscription(&self, subscriber: &str, watch_type: &str, watch_target: &str) -> Result<String>; // returns subscription ID
    async fn delete_subscription(&self, id: &str) -> Result<()>;
    async fn get_active_subscriptions(&self, subscriber: Option<&str>) -> Result<Vec<Subscription>>;
    async fn get_subscriptions_for_target(&self, watch_type: &str, watch_target: &str) -> Result<Vec<Subscription>>;
    async fn create_notification(&self, subscription_id: &str, triggered_by_node_id: &str, reason: &str) -> Result<()>;
    async fn get_unread_notifications(&self, subscriber: Option<&str>) -> Result<Vec<SubscriptionNotificationWithContext>>;
    async fn mark_notifications_read(&self, notification_ids: &[i64]) -> Result<()>;
    async fn update_last_checked(&self, subscription_id: &str) -> Result<()>;
}
```

Add `SubscriptionOps` to the `DatabaseBackend` supertrait.

#### 4. Postgres Implementation (add to src/db/postgres/ - new file subscriptions.rs or in the existing impl)

Implement `SubscriptionOps` for `PostgresDatabase`.

`SubscriptionNotificationWithContext` should join to synthesis_nodes to include one_liner, node_type, etc.

#### 5. MCP Tools (3 new tools)

Add to `src/mcp/tools/definitions.rs`:
- `memory_subscribe` - Subscribe to a node, entity, or topic
- `memory_unsubscribe` - Remove a subscription
- `memory_check_updates` - Get unread notifications (marks them read)

Create `src/mcp/tools/subscriptions.rs` with the implementations.

Update `call_tool` in `src/mcp/tools/mod.rs` to dispatch to new tools.

#### 6. Synthesis Worker Hook

In the synthesis worker (where new synthesis nodes are created and relationships are built), after a new node is created:
1. Check if the node relates to any entity that has active subscriptions (entity match)
2. Check if the node has edges to any subscribed nodes (node match)
3. For topic subscriptions, do a quick semantic similarity check
4. Create notifications for matching subscriptions

The hook should go in `src/synthesis/` wherever nodes are created/relationships are built.

### Important patterns to follow:
- Read existing MCP tool implementations (e.g., src/mcp/tools/create.rs) for the pattern
- Read existing DB trait implementations for the pattern  
- Use `tracing` for logging (debug!, info!, etc.)
- Use anyhow::Result for error handling
- Follow the existing code style exactly
- Make sure to add the new module to mod.rs files
- The `DatabaseBackend` supertrait in src/db/traits.rs needs `SubscriptionOps` added

### Testing:
- Run `cargo check` to verify compilation
- Run `cargo test` to run unit tests
- Don't run integration tests (they need a DB)

Be thorough. Read existing code first. Match the patterns exactly.

## Build TotalRecall Pub/Sub Subscriptions System

Working directory: /Users/alexander/Projects/totalrecall-rs

You're building a reactive pub/sub memory system for TotalRecall. Agents can subscribe to nodes/entities/topics and get notified when related new nodes are created.

### What to build:

#### 1. Database Migration (migrations/postgres/009_subscriptions.sql)

Two new tables:

```sql
-- Subscriptions: what agents are watching
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber TEXT NOT NULL,  -- agent/session identifier
    watch_type TEXT NOT NULL CHECK (watch_type IN ('node', 'entity', 'topic')),
    watch_target TEXT NOT NULL,  -- node UUID, entity name, or search query
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    last_checked BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Notifications: new related nodes for subscribers
CREATE TABLE IF NOT EXISTS subscription_notifications (
    id BIGSERIAL PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    triggered_by_node_id UUID NOT NULL REFERENCES synthesis_nodes(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,  -- why this notification was created
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber);
CREATE INDEX IF NOT EXISTS idx_subscriptions_watch ON subscriptions(watch_type, watch_target);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_subscription ON subscription_notifications(subscription_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON subscription_notifications(read) WHERE read = FALSE;
```

#### 2. Schema types (add to src/schema/mod.rs or wherever SynthesisNode etc are defined)

Add `Subscription` and `SubscriptionNotification` structs.

#### 3. DB Trait: SubscriptionOps (add to src/db/traits.rs)

```rust
#[async_trait]
pub trait SubscriptionOps: Send + Sync {
    async fn create_subscription(&self, subscriber: &str, watch_type: &str, watch_target: &str) -> Result<String>; // returns subscription ID
    async fn delete_subscription(&self, id: &str) -> Result<()>;
    async fn get_active_subscriptions(&self, subscriber: Option<&str>) -> Result<Vec<Subscription>>;
    async fn get_subscriptions_for_target(&self, watch_type: &str, watch_target: &str) -> Result<Vec<Subscription>>;
    async fn create_notification(&self, subscription_id: &str, triggered_by_node_id: &str, reason: &str) -> Result<()>;
    async fn get_unread_notifications(&self, subscriber: Option<&str>) -> Result<Vec<SubscriptionNotificationWithContext>>;
    async fn mark_notifications_read(&self, notification_ids: &[i64]) -> Result<()>;
    async fn update_last_checked(&self, subscription_id: &str) -> Result<()>;
}
```

Add `SubscriptionOps` to the `DatabaseBackend` supertrait.

#### 4. Postgres Implementation (add to src/db/postgres/ - new file subscriptions.rs or in the existing impl)

Implement `SubscriptionOps` for `PostgresDatabase`.

`SubscriptionNotificationWithContext` should join to synthesis_nodes to include one_liner, node_type, etc.

#### 5. MCP Tools (3 new tools)

Add to `src/mcp/tools/definitions.rs`:
- `memory_subscribe` - Subscribe to a node, entity, or topic
- `memory_unsubscribe` - Remove a subscription
- `memory_check_updates` - Get unread notifications (marks them read)

Create `src/mcp/tools/subscriptions.rs` with the implementations.

Update `call_tool` in `src/mcp/tools/mod.rs` to dispatch to new tools.

#### 6. Synthesis Worker Hook

In the synthesis worker (where new synthesis nodes are created and relationships are built), after a new node is created:
1. Check if the node relates to any entity that has active subscriptions (entity match)
2. Check if the node has edges to any subscribed nodes (node match)
3. For topic subscriptions, do a quick semantic similarity check
4. Create notifications for matching subscriptions

The hook should go in `src/synthesis/` wherever nodes are created/relationships are built.

### Important patterns to follow:
- Read existing MCP tool implementations (e.g., src/mcp/tools/create.rs) for the pattern
- Read existing DB trait implementations for the pattern  
- Use `tracing` for logging (debug!, info!, etc.)
- Use anyhow::Result for error handling
- Follow the existing code style exactly
- Make sure to add the new module to mod.rs files
- The `DatabaseBackend` supertrait in src/db/traits.rs needs `SubscriptionOps` added

### Testing:
- Run `cargo check` to verify compilation
- Run `cargo test` to run unit tests
- Don't run integration tests (they need a DB)

Be thorough. Read existing code first. Match the patterns exactly.


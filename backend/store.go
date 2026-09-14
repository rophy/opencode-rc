package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type SessionMeta struct {
	ID           string    `json:"id"`
	UserID       string    `json:"userId"`
	Directory    string    `json:"directory"`
	TunnelerAddr string    `json:"tunnelerAddr"`
	CreatedAt    time.Time `json:"createdAt"`
}

type SessionStore interface {
	Put(ctx context.Context, meta SessionMeta) error
	Get(ctx context.Context, sessionID string) (SessionMeta, bool, error)
	Delete(ctx context.Context, sessionID string) error
	List(ctx context.Context, userID string) ([]SessionMeta, error)
	Ping(ctx context.Context) error
}

type redisStore struct {
	client *redis.Client
	ttl    time.Duration
}

func NewRedisStore(client *redis.Client, ttl time.Duration) SessionStore {
	return &redisStore{client: client, ttl: ttl}
}

func sessionKey(id string) string {
	return "orc:session:" + id
}

func userSessionsKey(userID string) string {
	return "orc:user-sessions:" + userID
}

func (r *redisStore) Put(ctx context.Context, meta SessionMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	pipe := r.client.Pipeline()
	pipe.Set(ctx, sessionKey(meta.ID), data, r.ttl)
	pipe.SAdd(ctx, userSessionsKey(meta.UserID), meta.ID)
	pipe.Expire(ctx, userSessionsKey(meta.UserID), r.ttl)
	_, err = pipe.Exec(ctx)
	return err
}

func (r *redisStore) Get(ctx context.Context, sessionID string) (SessionMeta, bool, error) {
	data, err := r.client.Get(ctx, sessionKey(sessionID)).Bytes()
	if err == redis.Nil {
		return SessionMeta{}, false, nil
	}
	if err != nil {
		return SessionMeta{}, false, err
	}

	var meta SessionMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return SessionMeta{}, false, fmt.Errorf("unmarshal session: %w", err)
	}
	return meta, true, nil
}

func (r *redisStore) Delete(ctx context.Context, sessionID string) error {
	meta, ok, err := r.Get(ctx, sessionID)
	if err != nil {
		return err
	}

	pipe := r.client.Pipeline()
	pipe.Del(ctx, sessionKey(sessionID))
	if ok {
		pipe.SRem(ctx, userSessionsKey(meta.UserID), sessionID)
	}
	_, err = pipe.Exec(ctx)
	return err
}

func (r *redisStore) List(ctx context.Context, userID string) ([]SessionMeta, error) {
	ids, err := r.client.SMembers(ctx, userSessionsKey(userID)).Result()
	if err != nil {
		return nil, err
	}

	if len(ids) == 0 {
		return nil, nil
	}

	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = sessionKey(id)
	}

	values, err := r.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}

	var result []SessionMeta
	var staleIDs []interface{}
	for i, val := range values {
		if val == nil {
			staleIDs = append(staleIDs, ids[i])
			continue
		}
		var meta SessionMeta
		if err := json.Unmarshal([]byte(val.(string)), &meta); err != nil {
			continue
		}
		result = append(result, meta)
	}

	if len(staleIDs) > 0 {
		r.client.SRem(ctx, userSessionsKey(userID), staleIDs...)
	}

	return result, nil
}

func (r *redisStore) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

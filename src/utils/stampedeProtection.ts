/**
 * Stampede Protection and Request Coalescing
 * 
 * Prevents cache stampedes (thundering herd) when:
 * 1. A cached value expires and many requests hit at once
 * 2. A cache miss triggers multiple identical DB queries
 * 
 * STRATEGIES IMPLEMENTED:
 * 
 * 1. Request Coalescing (Singleflight Pattern)
 *    - If multiple requests ask for the same data simultaneously,
 *      only one request actually fetches from the source
 *    - Other requests wait for and share the result
 * 
 * 2. Stale-While-Revalidate
 *    - Serve slightly stale data while refreshing in the background
 *    - Prevents user-facing latency during cache refresh
 * 
 * 3. Probabilistic Early Expiration (Optional)
 *    - Randomly refresh cache before it expires
 *    - Spreads out refresh load over time
 * 
 * 4. Lock-Based Refresh
 *    - Only one process can refresh a given cache key at a time
 *    - Others wait or get stale data
 */

import { logger } from './logger';
import { RedisCache, isRedisConnected } from '../config/redis';

// ============================================================================
// Request Coalescing (Singleflight Pattern)
// ============================================================================

type PendingRequest<T> = {
  promise: Promise<T>;
  startedAt: number;
};

// In-memory map of in-flight requests
const inFlightRequests = new Map<string, PendingRequest<any>>();

// Maximum time a request can be in-flight before we allow a new one
const MAX_IN_FLIGHT_MS = 30000; // 30 seconds

/**
 * Execute a function with request coalescing.
 * If the same key is already being fetched, return the existing promise.
 * 
 * @param key - Unique key for this request
 * @param fn - Function to execute (e.g., database query)
 * @returns Promise resolving to the function result
 */
export async function coalesce<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  // Check if there's already an in-flight request for this key
  const existing = inFlightRequests.get(key);
  
  if (existing) {
    // Check if the existing request hasn't been running too long
    if (Date.now() - existing.startedAt < MAX_IN_FLIGHT_MS) {
      logger.debug('Request coalesced', { key });
      return existing.promise;
    }
    // Request has been running too long, remove it and start fresh
    inFlightRequests.delete(key);
  }
  
  // Create new in-flight request
  const promise = (async () => {
    try {
      const result = await fn();
      return result;
    } finally {
      // Remove from in-flight map when done
      inFlightRequests.delete(key);
    }
  })();
  
  inFlightRequests.set(key, {
    promise,
    startedAt: Date.now(),
  });
  
  return promise;
}

// ============================================================================
// Stale-While-Revalidate Cache
// ============================================================================

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  ttl: number; // seconds
  staleTtl: number; // additional seconds to serve stale data
}

// In-memory SWR cache (for small, frequently accessed data)
const swrCache = new Map<string, CacheEntry<any>>();
const MAX_SWR_CACHE_SIZE = 1000;

/**
 * Get or set a cached value with stale-while-revalidate semantics.
 * 
 * @param key - Cache key
 * @param fetchFn - Function to fetch fresh data
 * @param options - Cache options
 * @returns The cached or freshly fetched value
 */
export async function getOrSetWithSWR<T>(
  key: string,
  fetchFn: () => Promise<T>,
  options: {
    ttl?: number; // Fresh TTL in seconds (default: 60)
    staleTtl?: number; // Stale TTL in seconds (default: 300)
    useRedis?: boolean; // Also cache in Redis (default: true)
    coalesce?: boolean; // Use request coalescing (default: true)
  } = {}
): Promise<{ value: T; fresh: boolean; source: 'cache' | 'fetch' }> {
  const {
    ttl = 60,
    staleTtl = 300,
    useRedis = true,
    coalesce: shouldCoalesce = true,
  } = options;
  
  const now = Date.now();
  
  // 1. Check in-memory cache first
  const memoryEntry = swrCache.get(key);
  if (memoryEntry) {
    const age = (now - memoryEntry.createdAt) / 1000;
    
    if (age < memoryEntry.ttl) {
      // Still fresh
      return { value: memoryEntry.value, fresh: true, source: 'cache' };
    }
    
    if (age < memoryEntry.ttl + memoryEntry.staleTtl) {
      // Stale but usable - return immediately and refresh in background
      logger.debug('Serving stale data, refreshing in background', { key, age });
      refreshInBackground(key, fetchFn, ttl, staleTtl, useRedis);
      return { value: memoryEntry.value, fresh: false, source: 'cache' };
    }
  }
  
  // 2. Check Redis if enabled
  if (useRedis && isRedisConnected()) {
    try {
      const cached = await RedisCache.get(`swr:${key}`);
      if (cached) {
        const entry = JSON.parse(cached) as CacheEntry<T>;
        const age = (now - entry.createdAt) / 1000;
        
        // Update memory cache
        setMemoryCache(key, entry.value, ttl, staleTtl);
        
        if (age < entry.ttl) {
          return { value: entry.value, fresh: true, source: 'cache' };
        }
        
        if (age < entry.ttl + entry.staleTtl) {
          refreshInBackground(key, fetchFn, ttl, staleTtl, useRedis);
          return { value: entry.value, fresh: false, source: 'cache' };
        }
      }
    } catch (error) {
      logger.warn('Redis SWR cache read failed', { key, error });
    }
  }
  
  // 3. Cache miss - fetch fresh data
  const fetchFnWithCoalescing = shouldCoalesce
    ? () => coalesce(`swr:${key}`, fetchFn)
    : fetchFn;
  
  try {
    const value = await fetchFnWithCoalescing();
    
    // Update caches
    setMemoryCache(key, value, ttl, staleTtl);
    if (useRedis && isRedisConnected()) {
      setRedisCache(key, value, ttl, staleTtl).catch(err => 
        logger.warn('Redis SWR cache write failed', { key, error: err })
      );
    }
    
    return { value, fresh: true, source: 'fetch' };
  } catch (error) {
    // If fetch fails and we have stale data, return it
    if (memoryEntry) {
      logger.warn('Fetch failed, returning stale data', { key, error });
      return { value: memoryEntry.value, fresh: false, source: 'cache' };
    }
    throw error;
  }
}

// Background refresh function
const refreshingKeys = new Set<string>();

async function refreshInBackground<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number,
  staleTtl: number,
  useRedis: boolean
): Promise<void> {
  // Prevent multiple simultaneous refreshes
  if (refreshingKeys.has(key)) {
    return;
  }
  
  refreshingKeys.add(key);
  
  try {
    const value = await coalesce(`swr:refresh:${key}`, fetchFn);
    
    setMemoryCache(key, value, ttl, staleTtl);
    if (useRedis && isRedisConnected()) {
      await setRedisCache(key, value, ttl, staleTtl);
    }
    
    logger.debug('Background refresh completed', { key });
  } catch (error) {
    logger.warn('Background refresh failed', { key, error });
  } finally {
    refreshingKeys.delete(key);
  }
}

function setMemoryCache<T>(key: string, value: T, ttl: number, staleTtl: number): void {
  // Prevent unbounded growth
  if (swrCache.size >= MAX_SWR_CACHE_SIZE) {
    // Remove oldest entries
    const entries = Array.from(swrCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    entries.slice(0, Math.floor(MAX_SWR_CACHE_SIZE / 4)).forEach(([k]) => swrCache.delete(k));
  }
  
  swrCache.set(key, {
    value,
    createdAt: Date.now(),
    ttl,
    staleTtl,
  });
}

async function setRedisCache<T>(key: string, value: T, ttl: number, staleTtl: number): Promise<void> {
  const entry: CacheEntry<T> = {
    value,
    createdAt: Date.now(),
    ttl,
    staleTtl,
  };
  
  // Store with total TTL (fresh + stale)
  await RedisCache.set(
    `swr:${key}`,
    JSON.stringify(entry),
    ttl + staleTtl
  );
}

// ============================================================================
// Lock-Based Cache Refresh
// ============================================================================

/**
 * Refresh a cache key with distributed locking.
 * Only one process will perform the refresh at a time.
 * 
 * @param key - Cache key to refresh
 * @param fetchFn - Function to fetch fresh data
 * @param lockTtl - Lock TTL in seconds
 * @returns True if this process performed the refresh, false if another did
 */
export async function refreshWithLock<T>(
  key: string,
  fetchFn: () => Promise<T>,
  lockTtl: number = 30
): Promise<{ refreshed: boolean; value: T | null }> {
  if (!isRedisConnected()) {
    // Can't lock without Redis, just refresh
    const value = await fetchFn();
    return { refreshed: true, value };
  }
  
  const lockKey = `lock:refresh:${key}`;
  
  try {
    // Try to acquire lock
    const client = (await import('../config/redis')).getRedisClient();
    if (!client?.isOpen) {
      const value = await fetchFn();
      return { refreshed: true, value };
    }
    
    const acquired = await client.set(lockKey, Date.now().toString(), {
      NX: true,
      EX: lockTtl,
    });
    
    if (acquired !== 'OK') {
      // Lock not acquired, another process is refreshing
      logger.debug('Lock not acquired, skipping refresh', { key });
      return { refreshed: false, value: null };
    }
    
    // Lock acquired, perform refresh
    try {
      const value = await fetchFn();
      return { refreshed: true, value };
    } finally {
      // Release lock
      await client.del(lockKey);
    }
  } catch (error) {
    logger.error('Error in refreshWithLock', { key, error });
    throw error;
  }
}

// ============================================================================
// Probabilistic Early Expiration (XFetch Algorithm)
// ============================================================================

/**
 * Probabilistically decide if we should refresh early.
 * Based on the XFetch algorithm.
 * 
 * @param createdAt - When the cache entry was created
 * @param ttl - TTL in seconds
 * @param beta - How aggressive to be (default: 1.0)
 * @returns True if we should refresh early
 */
export function shouldRefreshEarly(
  createdAt: number,
  ttl: number,
  beta: number = 1.0
): boolean {
  const age = (Date.now() - createdAt) / 1000;
  const remaining = ttl - age;
  
  if (remaining <= 0) {
    return true; // Already expired
  }
  
  // XFetch: probability increases as expiration approaches
  // P = exp(-random * beta * remaining)
  const probability = Math.exp(-Math.random() * beta * (remaining / ttl));
  
  return Math.random() < probability;
}

// ============================================================================
// Exports and Utilities
// ============================================================================

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats() {
  return {
    memoryCache: {
      size: swrCache.size,
      maxSize: MAX_SWR_CACHE_SIZE,
    },
    inFlight: {
      size: inFlightRequests.size,
      keys: Array.from(inFlightRequests.keys()).slice(0, 10),
    },
    refreshing: {
      size: refreshingKeys.size,
      keys: Array.from(refreshingKeys).slice(0, 10),
    },
  };
}

/**
 * Clear all caches (for testing)
 */
export function clearCaches(): void {
  swrCache.clear();
  inFlightRequests.clear();
  refreshingKeys.clear();
}

/**
 * Invalidate a specific key from all caches
 */
export async function invalidate(key: string): Promise<void> {
  swrCache.delete(key);
  
  if (isRedisConnected()) {
    try {
      await RedisCache.del(`swr:${key}`);
    } catch (error) {
      logger.warn('Failed to invalidate Redis cache', { key, error });
    }
  }
}

/**
 * Shell Output Cache - True LRU cache for common shell command outputs.
 *
 * This module provides a caching layer for shell command outputs to reduce
 * repeated process spawning overhead for frequently-run commands.
 *
 * Features:
 * - LRU (Least Recently Used) eviction: when full, removes least recently accessed entry
 * - TTL (Time To Live): entries expire after TTL
 * - Size-limited: max 100 entries
 *
 * Usage:
 *   import { getShellCache, setShellCache } from "./shell-cache.js";
 *
 *   const cached = getShellCache(command, cwd);
 *   if (cached) return cached;
 *   // ... execute command ...
 *   setShellCache(command, cwd, result);
 */

// Simple LRU cache with max 100 entries
const MAX_CACHE_ENTRIES = 100;
const CACHE_TTL_MS = 5000; // 5 seconds TTL

interface CacheEntry {
  output: string;
  error: string;
  exitCode: number;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(command: string, cwd: string): string {
  return `${cwd}::${command}`;
}

export function getShellCache(command: string, cwd: string): CacheEntry | null {
  const key = getCacheKey(command, cwd);
  const entry = cache.get(key);
  
  if (!entry) return null;
  
  // Check TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  
  // LRU: Move accessed entry to end (most recently used)
  cache.delete(key);
  cache.set(key, entry);
  
  return entry;
}

export function setShellCache(command: string, cwd: string, output: string, error: string, exitCode: number): void {
  const key = getCacheKey(command, cwd);
  
  // If key already exists, delete it first (to update position)
  if (cache.has(key)) {
    cache.delete(key);
  }
  
  // Evict least recently used (first entry) if at capacity
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const lruKey = cache.keys().next().value;
    if (lruKey) cache.delete(lruKey);
  }
  
  // Add new entry at end (most recently used)
  cache.set(key, {
    output,
    error,
    exitCode,
    timestamp: Date.now(),
  });
}

export function clearShellCache(): void {
  cache.clear();
}

export function getShellCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return {
    size: cache.size,
    maxSize: MAX_CACHE_ENTRIES,
    ttlMs: CACHE_TTL_MS,
  };
}

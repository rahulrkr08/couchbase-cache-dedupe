'use strict'

const { test } = require('tap')
const { createCache, createStorage } = require('async-cache-dedupe')
const { CouchbaseStorage } = require('../index')

// Mock Couchbase collection
class MockCollection {
  constructor () {
    this.data = new Map()
    this.name = 'testCollection'
    this.scope = {
      name: 'testScope',
      bucket: {
        name: 'testBucket',
        cluster: {
          query: async (queryString) => {
            const rows = []
            for (const [key] of this.data.entries()) {
              if (key.startsWith('ref:')) {
                rows.push({ id: key })
              }
            }
            return { rows }
          }
        }
      }
    }
  }

  async get (key) {
    if (this.data.has(key)) {
      return { content: this.data.get(key) }
    }
    const error = new Error('Document not found')
    error.name = 'DocumentNotFoundError'
    throw error
  }

  async upsert (key, value, options = {}) {
    this.data.set(key, value)
  }

  async remove (key) {
    if (!this.data.has(key)) {
      const error = new Error('Document not found')
      error.name = 'DocumentNotFoundError'
      throw error
    }
    this.data.delete(key)
  }

  clear () {
    this.data.clear()
  }
}

test('Integration with async-cache-dedupe', async (t) => {
  t.test('should work with createStorage and createCache', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 60 }
      })
    })

    const cache = createCache({
      ttl: 5,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchUser', {
      references: (args, key, result) => result ? [`user:${result.id}`] : null
    }, async (id) => {
      callCount++
      return { id, name: `User ${id}` }
    })

    // First call should execute the function
    const result1 = await cache.fetchUser(1)
    t.same(result1, { id: 1, name: 'User 1' })
    t.equal(callCount, 1)

    // Second call should use cache
    const result2 = await cache.fetchUser(1)
    t.same(result2, { id: 1, name: 'User 1' })
    t.equal(callCount, 1)

    // Third call with different ID should execute again
    const result3 = await cache.fetchUser(2)
    t.same(result3, { id: 2, name: 'User 2' })
    t.equal(callCount, 2)
  })

  t.test('should handle cache invalidation by reference', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 60 }
      })
    })

    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchUser', {
      references: (args, key, result) => result ? [`user:${result.id}`] : null
    }, async (id) => {
      callCount++
      return { id, name: `User ${id}`, updatedAt: Date.now() }
    })

    // Cache user 1
    const result1 = await cache.fetchUser(1)
    t.equal(callCount, 1)

    // Should use cache
    await cache.fetchUser(1)
    t.equal(callCount, 1)

    // Invalidate user 1
    await cache.invalidateAll('user:1')

    // Should execute function again after invalidation
    const result2 = await cache.fetchUser(1)
    t.equal(callCount, 2)
    t.ok(result2.updatedAt > result1.updatedAt)
  })

  t.test('should handle wildcard invalidation', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 60 }
      })
    })

    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchUser', {
      references: (args, key, result) => result ? [`user:${result.id}`] : null
    }, async (id) => {
      callCount++
      return { id, name: `User ${id}` }
    })

    // Cache multiple users
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    await cache.fetchUser(3)
    t.equal(callCount, 3)

    // Should use cache
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    t.equal(callCount, 3)

    // Invalidate all users with wildcard
    await cache.invalidateAll('user:*')

    // Should execute functions again after invalidation
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    await cache.fetchUser(3)
    t.equal(callCount, 6)
  })

  t.test('should handle multiple references per entry', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 60 }
      })
    })

    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchUserPosts', {
      references: (args, key, result) => {
        if (!result) return null
        return [`user:${args[0]}`, `posts:user:${args[0]}`]
      }
    }, async (userId) => {
      callCount++
      return { userId, posts: [1, 2, 3] }
    })

    // Cache user posts
    await cache.fetchUserPosts(1)
    t.equal(callCount, 1)

    // Should use cache
    await cache.fetchUserPosts(1)
    t.equal(callCount, 1)

    // Invalidate by user reference
    await cache.invalidateAll('user:1')

    // Should execute function again
    await cache.fetchUserPosts(1)
    t.equal(callCount, 2)

    // Cache again
    await cache.fetchUserPosts(1)
    t.equal(callCount, 2)

    // Invalidate by posts reference
    await cache.invalidateAll('posts:user:1')

    // Should execute function again
    await cache.fetchUserPosts(1)
    t.equal(callCount, 3)
  })

  t.test('should handle cache.clear()', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return { id, data: `Data ${id}` }
    })

    // Cache multiple entries
    await cache.fetchData(1)
    await cache.fetchData(2)
    t.equal(callCount, 2)

    // Clear specific function cache
    cache.clear('fetchData')

    // Should execute functions again
    await cache.fetchData(1)
    await cache.fetchData(2)
    t.equal(callCount, 4)
  })

  t.test('should support deduplication', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 5,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchSomething', async (k) => {
      callCount++
      // Simulate async operation
      await new Promise(resolve => setTimeout(resolve, 10))
      return { k }
    })

    // Make concurrent calls with same parameter
    const p1 = cache.fetchSomething(42)
    const p2 = cache.fetchSomething(42)
    const p3 = cache.fetchSomething(42)

    const [result1, result2, result3] = await Promise.all([p1, p2, p3])

    // All should return same result
    t.same(result1, { k: 42 })
    t.same(result2, { k: 42 })
    t.same(result3, { k: 42 })

    // Function should only be called once due to deduplication
    t.equal(callCount, 1)
  })

  t.test('should work with bucket option', async (t) => {
    const collection = new MockCollection()
    const bucket = {
      defaultCollection: () => collection
    }
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ bucket })
    })

    const cache = createCache({
      ttl: 5,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return { id }
    })

    const result = await cache.fetchData(1)
    t.same(result, { id: 1 })
    t.equal(callCount, 1)

    // Should use cache
    await cache.fetchData(1)
    t.equal(callCount, 1)
  })

  t.test('should handle TTL correctly', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 1, // 1 second TTL
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return { id, timestamp: Date.now() }
    })

    // First call
    const result1 = await cache.fetchData(1)
    t.equal(callCount, 1)

    // Should use cache
    await cache.fetchData(1)
    t.equal(callCount, 1)

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 1100))

    // Should execute function again after TTL expiration
    const result2 = await cache.fetchData(1)
    t.equal(callCount, 2)
    t.ok(result2.timestamp > result1.timestamp)
  })

  t.test('should handle array of references for invalidation', async (t) => {
    const collection = new MockCollection()
    
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 60 }
      })
    })

    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('fetchUser', {
      references: (args, key, result) => result ? [`user:${result.id}`] : null
    }, async (id) => {
      callCount++
      return { id, name: `User ${id}` }
    })

    // Cache multiple users
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    t.equal(callCount, 2)

    // Invalidate multiple users at once
    await cache.invalidateAll(['user:1', 'user:2'])

    // Should execute functions again
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    t.equal(callCount, 4)
  })
})

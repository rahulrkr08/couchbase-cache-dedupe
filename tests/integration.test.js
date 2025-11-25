'use strict'

const { test } = require('tap')
const { createCache, createStorage } = require('async-cache-dedupe')
const { CouchbaseStorage } = require('../index')
const couchbase = require('couchbase')

// Configuration from environment variables
const CB_HOST = process.env.CB_HOST || 'localhost'
const CB_USER = process.env.CB_ADMIN || 'Administrator'
const CB_PASSWORD = process.env.CB_PASSWORD || 'password'
const CB_BUCKET = process.env.CB_BUCKET || 'test-bucket'
const CB_SCOPE = process.env.CB_SCOPE || 'test-scope'
const CB_COLLECTION = process.env.CB_COLLECTION || 'test-collection'

let cluster
let bucket
let collection

// Setup connection before tests
test.before(async () => {
  try {
    console.log(`Connecting to Couchbase at ${CB_HOST}...`)
    cluster = await couchbase.connect(`couchbase://${CB_HOST}`, {
      username: CB_USER,
      password: CB_PASSWORD,
      timeouts: {
        kvTimeout: 10000,
        queryTimeout: 10000
      }
    })

    bucket = cluster.bucket(CB_BUCKET)
    const scope = bucket.scope(CB_SCOPE)
    collection = scope.collection(CB_COLLECTION)

    console.log('Connected to Couchbase successfully!')
  } catch (error) {
    console.error('Failed to connect to Couchbase:', error.message)
    console.error('Make sure Couchbase is running and initialized:')
    console.error('  npm run couchbase:start')
    console.error('  npm run couchbase:init')
    throw error
  }
})

// Cleanup after all tests
test.teardown(async () => {
  if (cluster) {
    await cluster.close()
  }
})

test('Integration with async-cache-dedupe', async (t) => {
  t.test('should work with createStorage and createCache', async (t) => {
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors if no documents exist
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

    // Use the default collection for this test
    const defaultCollection = bucket.defaultCollection()

    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection: defaultCollection })
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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

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

  t.test('should handle long keys with hash generation', async (t) => {
    // Clear any existing data
    try {
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors
    }

    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        maxKeyLength: 50 // Set a low limit to trigger hashing
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
    cache.define('fetchData', async (id) => {
      callCount++
      return { id, data: `Data for ${id}` }
    })

    // Create a very long key that exceeds the limit
    const longKey = 'x'.repeat(100)

    // First call should execute the function
    const result1 = await cache.fetchData(longKey)
    t.same(result1, { id: longKey, data: `Data for ${longKey}` })
    t.equal(callCount, 1)

    // Second call should use cache (proving hash worked)
    const result2 = await cache.fetchData(longKey)
    t.same(result2, { id: longKey, data: `Data for ${longKey}` })
    t.equal(callCount, 1, 'Should use cached value with hashed key')
  })
})

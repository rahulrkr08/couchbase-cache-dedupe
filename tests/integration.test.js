'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
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
test.after(async () => {
  if (cluster) {
    await cluster.close()
  }
})

test('Integration with async-cache-dedupe', async (t) => {
  t.beforeEach(async () => {
    // Clear any existing data
    try {
      // Use REQUEST_PLUS scan consistency to ensure we see all documents
      const deleteQuery = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(deleteQuery, {
        scanConsistency: couchbase.QueryScanConsistency.RequestPlus
      })
    } catch (error) {
      console.error('Error in beforeEach cleanup:', error.message)
      // Don't throw - allow test to proceed
    }
  })

  await t.test('should work with createStorage and createCache', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 100000 }
      })
    })

    const cache = createCache({
      ttl: 100000,
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
    assert.deepEqual(result1, { id: 1, name: 'User 1' })
    assert.equal(callCount, 1)

    // Second call should use cache
    const result2 = await cache.fetchUser(1)
    assert.deepEqual(result2, { id: 1, name: 'User 1' })
    assert.equal(callCount, 1)

    await cache.invalidate('fetchUser', ['user:1'])

    const result3 = await cache.fetchUser(1)
    assert.deepEqual(result3, { id: 1, name: 'User 1' })
    assert.equal(callCount, 2)

    // Third call with different ID should execute again
    const result4 = await cache.fetchUser(2)
    assert.deepEqual(result4, { id: 2, name: 'User 2' })
    assert.equal(callCount, 3)
  })

  await t.test('should handle cache invalidation by reference', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 100000 }
      })
    })

    const cache = createCache({
      ttl: 100000,
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
    assert.equal(callCount, 1)

    // Should use cache
    await cache.fetchUser(1)
    assert.equal(callCount, 1)

    // Invalidate user 1
    await cache.invalidate('fetchUser', ['user:1'])

    // Should execute function again after invalidation
    const result2 = await cache.fetchUser(1)
    assert.equal(callCount, 2)
    assert.ok(result2.updatedAt >= result1.updatedAt)
  })

  await t.test('should handle wildcard invalidation', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 100000 }
      })
    })

    const cache = createCache({
      ttl: 100000,
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
    assert.equal(callCount, 3)

    // Should use cache
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    assert.equal(callCount, 3)

    // Invalidate all users with wildcard
    await cache.invalidate('fetchUser', ['user:*'])

    // Should execute functions again after invalidation
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    await cache.fetchUser(3)
    assert.equal(callCount, 6)
  })

  await t.test('should automatically handle long keys with hash generation', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection
      })
    })

    const cache = createCache({
      ttl: 100000,
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

    // Create a very long key (over 200 bytes) that will be automatically hashed
    const longKey = 'x'.repeat(250)

    // First call should execute the function
    const result1 = await cache.fetchData(longKey)
    assert.deepEqual(result1, { id: longKey, data: `Data for ${longKey}` })
    assert.equal(callCount, 1)

    // Second call should use cache (proving automatic hash worked)
    const result2 = await cache.fetchData(longKey)
    assert.deepEqual(result2, { id: longKey, data: `Data for ${longKey}` })
    assert.equal(callCount, 1, 'Should use cached value with automatically hashed key')
  })

  await t.test('should cache different value types', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return id
    })

    // Test string
    const str = await cache.fetchData('test-string')
    assert.equal(str, 'test-string')

    // Test number
    const num = await cache.fetchData(42)
    assert.equal(num, 42)

    // Test boolean
    const bool = await cache.fetchData(true)
    assert.equal(bool, true)

    // Test array
    const arr = await cache.fetchData([1, 2, 3])
    assert.deepEqual(arr, [1, 2, 3])

    // All should be cached
    assert.equal(callCount, 4)

    // Verify caching works
    await cache.fetchData('test-string')
    await cache.fetchData(42)
    assert.equal(callCount, 4)
  })

  await t.test('should handle cache deduplication correctly', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
    })

    let callCount = 0
    cache.define('fetchSlow', async (id) => {
      callCount++
      // Simulate slow operation
      await new Promise(resolve => setTimeout(resolve, 100))
      return { id, value: `Result ${id}` }
    })

    // Make concurrent calls with same parameter
    const promises = [
      cache.fetchSlow(1),
      cache.fetchSlow(1),
      cache.fetchSlow(1)
    ]

    const results = await Promise.all(promises)

    // All should return same result
    assert.deepEqual(results[0], { id: 1, value: 'Result 1' })
    assert.deepEqual(results[1], { id: 1, value: 'Result 1' })
    assert.deepEqual(results[2], { id: 1, value: 'Result 1' })

    // Function should only be called once due to deduplication
    assert.equal(callCount, 1)
  })

  await t.test('should handle multiple references per entry', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 100000 }
      })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
    })

    let callCount = 0
    cache.define('fetchUserWithPosts', {
      references: (_args, _key, result) => {
        if (!result) return null
        return [`user:${result.userId}`, `posts:${result.userId}`]
      }
    }, async (userId) => {
      callCount++
      return { userId, posts: [1, 2, 3] }
    })

    // Cache user posts
    await cache.fetchUserWithPosts(1)
    assert.equal(callCount, 1)

    // Should use cache
    await cache.fetchUserWithPosts(1)
    assert.equal(callCount, 1)

    // Invalidate by user reference
    await cache.invalidate('fetchUserWithPosts', ['user:1'])
    // await new Promise((resolve) => setTimeout(() => resolve(), 1000))
    // Should execute function again
    await cache.fetchUserWithPosts(1)
    assert.equal(callCount, 2)

    // Cache again
    await cache.fetchUserWithPosts(1)
    assert.equal(callCount, 2)

    // Invalidate by posts reference
    await cache.invalidate('fetchUserWithPosts', ['posts:1'])

    // Should execute function again
    await cache.fetchUserWithPosts(1)
    assert.equal(callCount, 3)
  })

  await t.test('should handle array of references for bulk invalidation', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({
        collection,
        invalidation: { referencesTTL: 100000 }
      })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
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
    assert.equal(callCount, 3)

    // Invalidate multiple users at once
    await cache.invalidate('fetchUser', ['user:1', 'user:2'])

    // Should execute functions again for invalidated users
    await cache.fetchUser(1)
    await cache.fetchUser(2)
    assert.equal(callCount, 5)

    // User 3 should still be cached
    await cache.fetchUser(3)
    assert.equal(callCount, 5)
  })

  await t.test('should handle clear operation', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return { id, data: `Data ${id}` }
    })

    // Cache multiple entries
    await cache.fetchData(1)
    await cache.fetchData(2)
    assert.equal(callCount, 2)

    // Clear specific function cache
    await cache.clear('fetchData')

    // Should execute functions again
    await cache.fetchData(1)
    await cache.fetchData(2)
    assert.equal(callCount, 4)
  })

  await t.test('should handle special characters in keys', async (t) => {
    const storage = createStorage('custom', {
      storage: new CouchbaseStorage({ collection })
    })

    const cache = createCache({
      ttl: 100000,
      storage: { type: 'custom', options: { storage } }
    })

    let callCount = 0
    cache.define('fetchData', async (id) => {
      callCount++
      return { id }
    })

    // Test keys with special characters
    const specialKeys = [
      'key:with:colons',
      'key-with-dashes',
      'key_with_underscores',
      'key.with.dots',
      'key with spaces'
    ]

    for (const key of specialKeys) {
      await cache.fetchData(key)
    }

    assert.equal(callCount, specialKeys.length)

    // Verify caching works with special chars
    for (const key of specialKeys) {
      await cache.fetchData(key)
    }

    assert.equal(callCount, specialKeys.length)
  })
})

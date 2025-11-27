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
      const query = `DELETE FROM \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\``
      await cluster.query(query)
    } catch (error) {
      // Ignore errors if no documents exist
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
})

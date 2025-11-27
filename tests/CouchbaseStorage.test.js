const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert')
const CouchbaseStorage = require('../lib/storage')

describe('CouchbaseStorage', () => {
  let storage
  let mockCollection
  let mockBucket
  let mockScope
  let mockCluster

  beforeEach(() => {
    // Create mock cluster
    mockCluster = {
      query: mock.fn(async () => ({ rows: [] }))
    }

    // Create mock scope
    mockScope = {
      bucket: null, // Will be set after mockBucket is created
      name: '_default'
    }

    // Create mock bucket
    mockBucket = {
      name: 'test-bucket',
      cluster: mockCluster,
      defaultCollection: mock.fn(() => mockCollection)
    }

    // Set bucket reference in scope
    mockScope.bucket = mockBucket

    // Create mock collection
    mockCollection = {
      name: '_default',
      scope: mockScope,
      get: mock.fn(async (key) => {
        throw { name: 'DocumentNotFoundError' }
      }),
      upsert: mock.fn(async () => ({})),
      remove: mock.fn(async () => ({})),
      exists: mock.fn(async () => ({})),
      touch: mock.fn(async () => ({}))
    }

    // Update bucket's defaultCollection to return our mockCollection
    mockBucket.defaultCollection.mock.mockImplementation(() => mockCollection)
  })

  afterEach(() => {
    mock.reset()
  })

  describe('constructor', () => {
    it('should throw error if neither collection nor bucket is provided', () => {
      assert.throws(
        () => new CouchbaseStorage({}),
        /Either collection or bucket must be provided/
      )
    })

    it('should throw error if options is null', () => {
      assert.throws(
        () => new CouchbaseStorage(null),
        /Cannot read property/
      )
    })

    it('should use provided collection directly', () => {
      storage = new CouchbaseStorage({ collection: mockCollection })
      assert.strictEqual(storage.collection, mockCollection)
    })

    it('should use bucket default collection when only bucket is provided', () => {
      storage = new CouchbaseStorage({ bucket: mockBucket })
      assert.strictEqual(mockBucket.defaultCollection.mock.calls.length, 1)
      assert.strictEqual(storage.collection, mockCollection)
    })

    it('should initialize with correct prefixes', () => {
      storage = new CouchbaseStorage({ collection: mockCollection })
      assert.strictEqual(storage.referencesPrefix, 'r:')
      assert.strictEqual(storage.valuePrefix, 'v:')
    })

    it('should initialize with correct maxKeyLength', () => {
      storage = new CouchbaseStorage({ collection: mockCollection })
      assert.strictEqual(storage.maxKeyLength, 200)
    })
  })

  describe('get', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should return cached value when key exists', async () => {
      const testValue = { data: 'test' }
      mockCollection.get.mock.mockImplementation(async () => ({
        content: testValue
      }))

      const result = await storage.get('test-key')
      assert.deepStrictEqual(result, testValue)
      assert.strictEqual(mockCollection.get.mock.calls.length, 1)
      assert.strictEqual(mockCollection.get.mock.calls[0].arguments[0], 'v:test-key')
    })

    it('should return undefined when key does not exist', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      const result = await storage.get('non-existent')
      assert.strictEqual(result, undefined)
    })

    it('should throw error for non-DocumentNotFoundError errors', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      await assert.rejects(
        () => storage.get('test-key'),
        /Connection error/
      )
    })

    it('should handle string values', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: 'simple string'
      }))

      const result = await storage.get('string-key')
      assert.strictEqual(result, 'simple string')
    })

    it('should handle number values', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: 42
      }))

      const result = await storage.get('number-key')
      assert.strictEqual(result, 42)
    })

    it('should handle boolean values', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: true
      }))

      const result = await storage.get('bool-key')
      assert.strictEqual(result, true)
    })

    it('should handle array values', async () => {
      const arrayValue = [1, 2, 3, 'test']
      mockCollection.get.mock.mockImplementation(async () => ({
        content: arrayValue
      }))

      const result = await storage.get('array-key')
      assert.deepStrictEqual(result, arrayValue)
    })

    it('should handle null values', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: null
      }))

      const result = await storage.get('null-key')
      assert.strictEqual(result, null)
    })
  })

  describe('set', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should store value without references', async () => {
      const value = { data: 'test' }
      await storage.set('test-key', value, 60)

      assert.strictEqual(mockCollection.upsert.mock.calls.length, 1)
      const [key, storedValue, options] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(key, 'v:test-key')
      assert.deepStrictEqual(storedValue, value)
      assert.strictEqual(options.expiry, 60)
    })

    it('should store value with references', async () => {
      const value = { data: 'test' }
      const references = ['user:1', 'user:2']

      mockCollection.get.mock.mockImplementation(async (key) => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.set('test-key', value, 60, references)

      // Should store the main value + 2 reference documents
      assert.strictEqual(mockCollection.upsert.mock.calls.length, 3)

      // Check main value is stored directly
      const [mainKey, storedValue, mainOptions] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(mainKey, 'v:test-key')
      assert.deepStrictEqual(storedValue, value)
      assert.strictEqual(mainOptions.expiry, 60)

      // Check reference documents
      const refCalls = mockCollection.upsert.mock.calls.slice(1)
      assert.strictEqual(refCalls.length, 2)
    })

    it('should handle zero TTL', async () => {
      await storage.set('test-key', { data: 'test' }, 0)

      const [, , options] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(options.expiry, 0)
    })

    it('should handle negative TTL as zero', async () => {
      await storage.set('test-key', { data: 'test' }, -10)

      const [, , options] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(options.expiry, 0)
    })

    it('should store string values directly', async () => {
      await storage.set('string-key', 'test string', 60)

      const [, storedValue] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(storedValue, 'test string')
    })

    it('should store number values directly', async () => {
      await storage.set('number-key', 123, 60)

      const [, storedValue] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(storedValue, 123)
    })

    it('should store boolean values directly', async () => {
      await storage.set('bool-key', false, 60)

      const [, storedValue] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(storedValue, false)
    })

    it('should store array values directly', async () => {
      const arrayValue = [1, 2, { nested: 'object' }]
      await storage.set('array-key', arrayValue, 60)

      const [, storedValue] = mockCollection.upsert.mock.calls[0].arguments
      assert.deepStrictEqual(storedValue, arrayValue)
    })

    it('should handle null as value', async () => {
      await storage.set('null-key', null, 60)

      const [, storedValue] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(storedValue, null)
    })

    it('should handle empty string as key', async () => {
      await storage.set('', { data: 'test' }, 60)

      const [key] = mockCollection.upsert.mock.calls[0].arguments
      assert.strictEqual(key, 'v:')
    })

    it('should handle empty references array', async () => {
      await storage.set('test-key', { data: 'test' }, 60, [])

      // Should only store main value, no reference documents
      assert.strictEqual(mockCollection.upsert.mock.calls.length, 1)
    })

    it('should handle undefined references', async () => {
      await storage.set('test-key', { data: 'test' }, 60, undefined)

      // Should only store main value
      assert.strictEqual(mockCollection.upsert.mock.calls.length, 1)
    })

    it('should update existing reference documents', async () => {
      const references = ['user:1']
      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key === 'r:user:1') {
          return { content: { keys: ['existing-key'] } }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.set('test-key', { data: 'test' }, 60, references)

      // Find the reference upsert call
      const refCall = mockCollection.upsert.mock.calls.find(
        call => call.arguments[0] === 'r:user:1'
      )
      assert(refCall)
      assert.deepStrictEqual(refCall.arguments[1].keys, ['existing-key', 'test-key'])
    })

    it('should not duplicate keys in reference documents', async () => {
      const references = ['user:1']
      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key === 'r:user:1') {
          return { content: { keys: ['test-key'] } }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.set('test-key', { data: 'test' }, 60, references)

      const refCall = mockCollection.upsert.mock.calls.find(
        call => call.arguments[0] === 'r:user:1'
      )
      assert(refCall)
      assert.deepStrictEqual(refCall.arguments[1].keys, ['test-key'])
    })

    it('should continue with other references if one fails', async () => {
      const references = ['user:1', 'user:2']
      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key === 'r:user:1') {
          throw new Error('Connection error')
        }
        throw { name: 'DocumentNotFoundError' }
      })

      // Mock console.error to suppress error output during test
      const originalConsoleError = console.error
      console.error = mock.fn()

      await storage.set('test-key', { data: 'test' }, 60, references)

      // Should still store main document and attempt both references (even though one fails)
      // Main document + 2 reference attempts = 3 upsert calls
      // But if the get for user:1 fails, the upsert won't be called for it
      // So we should have: main document + user:2 reference = 2 upsert calls
      assert(mockCollection.upsert.mock.calls.length >= 2)
      assert.strictEqual(console.error.mock.calls.length, 1)

      console.error = originalConsoleError
    })
  })

  describe('remove', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should remove document', async () => {
      await storage.remove('test-key')

      assert.strictEqual(mockCollection.remove.mock.calls.length, 1)
      assert.strictEqual(mockCollection.remove.mock.calls[0].arguments[0], 'v:test-key')
    })

    it('should handle non-existent key', async () => {
      mockCollection.remove.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.remove('non-existent')
      // Should not throw
    })

    it('should handle remove error that is not DocumentNotFoundError', async () => {
      mockCollection.remove.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      await assert.rejects(
        () => storage.remove('test-key'),
        /Connection error/
      )
    })
  })

  describe('invalidate', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should invalidate single exact reference', async () => {
      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key === 'r:user:1') {
          return { content: { keys: ['key1', 'key2'] } }
        }
        if (key.startsWith('v:key')) {
          return { content: { value: 'test', references: ['user:1'] } }
        }
        if (key.startsWith('r:user')) {
          return { content: { keys: [] } }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.invalidate('user:1')

      // Should call remove for the reference document
      const removeCalls = mockCollection.remove.mock.calls
      const hasReferenceRemove = removeCalls.some(
        call => call.arguments[0] === 'r:user:1'
      )
      assert(hasReferenceRemove, 'Should remove reference document')
    })

    it('should invalidate array of references', async () => {
      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key === 'r:user:1' || key === 'r:user:2') {
          return { content: { keys: ['key1'] } }
        }
        if (key.startsWith('v:')) {
          return { content: { value: 'test', references: [] } }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.invalidate(['user:1', 'user:2'])

      const refGetCalls = mockCollection.get.mock.calls.filter(
        call => call.arguments[0].startsWith('r:user')
      )
      assert.strictEqual(refGetCalls.length, 2)
    })

    it('should handle wildcard pattern', async () => {
      mockCluster.query.mock.mockImplementation(async () => ({
        rows: [
          {
            id: 'r:user:1',
            [mockCollection.name]: { keys: ['key1'] }
          },
          {
            id: 'r:user:2',
            [mockCollection.name]: { keys: ['key2'] }
          }
        ]
      }))

      mockCollection.get.mock.mockImplementation(async (key) => {
        if (key.startsWith('v:')) {
          return { content: { value: 'test', references: [] } }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.invalidate('user:*')

      assert.strictEqual(mockCluster.query.mock.calls.length, 1)
      const queryCall = mockCluster.query.mock.calls[0]
      assert(queryCall.arguments[0].includes('LIKE'))
      assert(queryCall.arguments[0].includes('r:user:%'))
    })

    it('should handle non-existent reference', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.invalidate('non-existent')
      // Should not throw
    })

    it('should throw error when query service unavailable for wildcard', async () => {
      mockCluster.query.mock.mockImplementation(async () => {
        throw new Error('Query service not available')
      })

      await assert.rejects(
        () => storage.invalidate('user:*'),
        /Wildcard invalidation requires N1QL query service/
      )
    })

    it('should handle non-default scope and collection in wildcard query', async () => {
      mockScope.name = 'custom-scope'
      mockCollection.name = 'custom-collection'

      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('`test-bucket`.`custom-scope`.`custom-collection`'))
        return { rows: [] }
      })

      await storage.invalidate('user:*')
    })
  })

  describe('clear', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should clear all cache entries using N1QL query', async () => {
      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('DELETE FROM'))
        assert(query.includes('v:%') || query.includes('r:%'))
        return {}
      })

      await storage.clear()

      assert.strictEqual(mockCluster.query.mock.calls.length, 1)
    })

    it('should throw error when query service unavailable', async () => {
      mockCluster.query.mock.mockImplementation(async () => {
        throw new Error('Query service not available')
      })

      await assert.rejects(
        () => storage.clear(),
        /Clear operation requires N1QL query service/
      )
    })

    it('should handle non-default scope and collection', async () => {
      mockScope.name = 'custom-scope'
      mockCollection.name = 'custom-collection'

      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('`test-bucket`.`custom-scope`.`custom-collection`'))
        return {}
      })

      await storage.clear()
    })
  })

  describe('refresh', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should refresh TTL for existing key', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test', ttl: 60 }
      }))

      await storage.refresh('test-key')

      assert.strictEqual(mockCollection.touch.mock.calls.length, 1)
      assert.strictEqual(mockCollection.touch.mock.calls[0].arguments[0], 'v:test-key')
    })

    it('should handle non-existent key', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.refresh('non-existent')

      assert.strictEqual(mockCollection.touch.mock.calls.length, 0)
    })

    it('should handle touch DocumentNotFoundError', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test', ttl: 60 }
      }))

      mockCollection.touch.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.refresh('test-key')
      // Should not throw
    })

    it('should throw error for non-DocumentNotFoundError in touch', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test', ttl: 60 }
      }))

      mockCollection.touch.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      await assert.rejects(
        () => storage.refresh('test-key'),
        /Connection error/
      )
    })

    it('should use default ttl of 0 when not specified', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test' }
      }))

      await storage.refresh('test-key')

      assert.strictEqual(mockCollection.touch.mock.calls[0].arguments[1], 0)
    })
  })

  describe('getTTL', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should return remaining TTL for key', async () => {
      const futureTime = Math.floor(Date.now() / 1000) + 60
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test' },
        expiry: futureTime
      }))

      const ttl = await storage.getTTL('test-key')

      assert(ttl > 0 && ttl <= 60)
      assert.strictEqual(mockCollection.get.mock.calls.length, 1)
      assert.deepStrictEqual(
        mockCollection.get.mock.calls[0].arguments[1],
        { withExpiry: true }
      )
    })

    it('should return 0 for key without expiry', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test' },
        expiry: null
      }))

      const ttl = await storage.getTTL('test-key')

      assert.strictEqual(ttl, 0)
    })

    it('should return 0 for expired key', async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 60
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { value: 'test' },
        expiry: pastTime
      }))

      const ttl = await storage.getTTL('test-key')

      assert.strictEqual(ttl, 0)
    })

    it('should return 0 for non-existent key', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      const ttl = await storage.getTTL('non-existent')

      assert.strictEqual(ttl, 0)
    })

    it('should throw error for non-DocumentNotFoundError errors', async () => {
      mockCollection.get.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      await assert.rejects(
        () => storage.getTTL('test-key'),
        /Connection error/
      )
    })
  })

  describe('exists', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should return true when key exists', async () => {
      mockCollection.exists.mock.mockImplementation(async () => ({}))

      const result = await storage.exists('test-key')

      assert.strictEqual(result, true)
      assert.strictEqual(mockCollection.exists.mock.calls.length, 1)
      assert.strictEqual(mockCollection.exists.mock.calls[0].arguments[0], 'v:test-key')
    })

    it('should return false when key does not exist', async () => {
      mockCollection.exists.mock.mockImplementation(async () => {
        throw new Error('Not found')
      })

      const result = await storage.exists('non-existent')

      assert.strictEqual(result, false)
    })

    it('should return false for any error', async () => {
      mockCollection.exists.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      const result = await storage.exists('test-key')

      assert.strictEqual(result, false)
    })

    it('should check existence with prefixed key', async () => {
      mockCollection.exists.mock.mockImplementation(async () => ({}))

      await storage.exists('my-key')

      assert.strictEqual(mockCollection.exists.mock.calls[0].arguments[0], 'v:my-key')
    })
  })

  describe('clear', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should clear all cache entries using N1QL query', async () => {
      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('DELETE FROM'))
        assert(query.includes("LIKE 'v:%'") || query.includes("LIKE 'r:%'"))
        return {}
      })

      await storage.clear()

      assert.strictEqual(mockCluster.query.mock.calls.length, 1)
    })

    it('should use default keyspace for default scope/collection', async () => {
      mockScope.name = '_default'
      mockCollection.name = '_default'

      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('`test-bucket`'))
        assert(!query.includes('`_default`.`_default`'))
        return {}
      })

      await storage.clear()
    })

    it('should use full keyspace path for custom scope/collection', async () => {
      mockScope.name = 'custom-scope'
      mockCollection.name = 'custom-collection'

      mockCluster.query.mock.mockImplementation(async (query) => {
        assert(query.includes('`test-bucket`.`custom-scope`.`custom-collection`'))
        return {}
      })

      await storage.clear()
    })

    it('should throw error when query service unavailable', async () => {
      mockCluster.query.mock.mockImplementation(async () => {
        throw new Error('Query service not available')
      })

      await assert.rejects(
        () => storage.clear(),
        /Clear operation requires N1QL query service/
      )
    })
  })

  describe('refresh', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should refresh TTL for existing key', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { ttl: 60 }
      }))

      await storage.refresh('test-key')

      assert.strictEqual(mockCollection.touch.mock.calls.length, 1)
      assert.strictEqual(mockCollection.touch.mock.calls[0].arguments[0], 'v:test-key')
      assert.strictEqual(mockCollection.touch.mock.calls[0].arguments[1], 60)
    })

    it('should handle non-existent key gracefully', async () => {
      mockCollection.get.mock.mockImplementation(async () => undefined)

      await storage.refresh('non-existent')

      assert.strictEqual(mockCollection.touch.mock.calls.length, 0)
    })

    it('should use default ttl of 0 when not specified', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: {}
      }))

      await storage.refresh('test-key')

      assert.strictEqual(mockCollection.touch.mock.calls[0].arguments[1], 0)
    })

    it('should handle DocumentNotFoundError in touch', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { ttl: 60 }
      }))

      mockCollection.touch.mock.mockImplementation(async () => {
        throw { name: 'DocumentNotFoundError' }
      })

      await storage.refresh('test-key')
      // Should not throw
    })

    it('should throw error for non-DocumentNotFoundError in touch', async () => {
      mockCollection.get.mock.mockImplementation(async () => ({
        content: { ttl: 60 }
      }))

      mockCollection.touch.mock.mockImplementation(async () => {
        throw new Error('Connection error')
      })

      await assert.rejects(
        () => storage.refresh('test-key'),
        /Connection error/
      )
    })
  })

  describe('private helper methods', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should generate correct value key', () => {
      const key = storage._getValueKey('test')
      assert.strictEqual(key, 'v:test')
    })

    it('should generate correct reference key', () => {
      const key = storage._getReferenceKey('user:1')
      assert.strictEqual(key, 'r:user:1')
    })

    it('should automatically hash long keys that exceed 200 bytes', () => {
      const storage = new CouchbaseStorage({
        collection: mockCollection
      })

      // Create a key longer than 200 bytes
      const longKey = 'x'.repeat(250)
      const hashedKey = storage._getValueKey(longKey)

      // Should be hashed (SHA-256 hex = 64 chars + prefix)
      assert.strictEqual(hashedKey.length, 66) // 'v:' + 64 char hash
      assert(hashedKey.startsWith('v:'))
    })

    it('should not hash short keys (under 200 bytes)', () => {
      const storage = new CouchbaseStorage({
        collection: mockCollection
      })

      const shortKey = 'short'
      const key = storage._getValueKey(shortKey)

      // Short keys should remain as-is
      assert.strictEqual(key, 'v:short')
    })

    it('should generate consistent hashes for same key', () => {
      const storage = new CouchbaseStorage({
        collection: mockCollection
      })

      // Use a key longer than 200 bytes to trigger hashing
      const longKey = 'x'.repeat(250)
      const hash1 = storage._getValueKey(longKey)
      const hash2 = storage._getValueKey(longKey)

      // Same key should always produce same hash
      assert.strictEqual(hash1, hash2)
    })

    it('should automatically hash long reference keys', () => {
      const storage = new CouchbaseStorage({
        collection: mockCollection
      })

      // Create a reference key longer than 200 bytes
      const longRef = 'y'.repeat(250)
      const hashedRef = storage._getReferenceKey(longRef)

      // Should be hashed (SHA-256 hex = 64 chars + prefix)
      assert.strictEqual(hashedRef.length, 66) // 'r:' + 64 char hash
      assert(hashedRef.startsWith('r:'))
    })
  })

  describe('integration scenarios', () => {
    beforeEach(() => {
      storage = new CouchbaseStorage({ collection: mockCollection })
    })

    it('should handle complete cache lifecycle', async () => {
      // Setup
      const documents = new Map()

      mockCollection.get.mock.mockImplementation(async (key) => {
        if (documents.has(key)) {
          return { content: documents.get(key) }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      mockCollection.upsert.mock.mockImplementation(async (key, value) => {
        documents.set(key, value)
        return {}
      })

      mockCollection.remove.mock.mockImplementation(async (key) => {
        documents.delete(key)
        return {}
      })

      // Set value with references
      await storage.set('user-data', { name: 'John' }, 60, ['user:1'])

      // Get value
      const value = await storage.get('user-data')
      assert.deepStrictEqual(value, { name: 'John' })

      // Invalidate by reference
      await storage.invalidate('user:1')

      // Value should be removed
      const afterInvalidate = await storage.get('user-data')
      assert.strictEqual(afterInvalidate, undefined)
    })

    it('should handle multiple keys with same reference', async () => {
      const documents = new Map()

      mockCollection.get.mock.mockImplementation(async (key) => {
        if (documents.has(key)) {
          return { content: documents.get(key) }
        }
        throw { name: 'DocumentNotFoundError' }
      })

      mockCollection.upsert.mock.mockImplementation(async (key, value) => {
        documents.set(key, value)
        return {}
      })

      mockCollection.remove.mock.mockImplementation(async (key) => {
        documents.delete(key)
        return {}
      })

      // Set multiple values with same reference
      await storage.set('key1', { data: '1' }, 60, ['shared'])
      await storage.set('key2', { data: '2' }, 60, ['shared'])

      // Both should exist
      assert(documents.has('v:key1'))
      assert(documents.has('v:key2'))

      // Invalidate by shared reference
      await storage.invalidate('shared')

      // Both should be removed
      assert(!documents.has('v:key1'))
      assert(!documents.has('v:key2'))
    })
  })
})

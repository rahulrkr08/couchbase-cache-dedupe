# couchbase-cache-dedupe

[![npm version](https://img.shields.io/npm/v/couchbase-cache-dedupe.svg)](https://www.npmjs.com/package/couchbase-cache-dedupe)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Couchbase storage adapter for [async-cache-dedupe](https://github.com/mcollina/async-cache-dedupe). This package enables you to use Couchbase as a distributed cache backend with full support for deduplication, TTL, and reference-based invalidation.

## Features

- ✅ Full async-cache-dedupe storage interface implementation
- ✅ Support for TTL (Time To Live) with automatic expiration
- ✅ Reference-based cache invalidation
- ✅ Wildcard pattern matching for bulk invalidation
- ✅ Support for both Couchbase Collection and Bucket APIs
- ✅ **Automatic key hashing for long keys** (handles Couchbase 250-byte key limit)
- ✅ **Docker development environment included**
- ✅ Comprehensive error handling and logging
- ✅ 100% test coverage
- ✅ Pure JavaScript implementation (no TypeScript compilation needed)

## Installation

```bash
npm install couchbase-cache-dedupe async-cache-dedupe couchbase
```

## Requirements

- Node.js >= 16
- Couchbase Server >= 6.5
- couchbase SDK >= 4.0.0

## Quick Start

```javascript
const { createStorage, createCache } = require('async-cache-dedupe')
const { CouchbaseStorage } = require('couchbase-cache-dedupe')
const couchbase = require('couchbase')

// Connect to Couchbase
const cluster = await couchbase.connect('couchbase://localhost', {
  username: 'your_username',
  password: 'your_password',
})

const bucket = cluster.bucket('your_bucket_name')
const collection = bucket.defaultCollection()

// Create custom storage with CouchbaseStorage
const storage = createStorage('custom', {
  storage: new CouchbaseStorage({
    collection, // Use collection directly
  })
})

// Create cache with the custom storage
const cache = createCache({
  ttl: 5, // 5 seconds TTL
  storage: {
    type: 'custom',
    options: { storage }
  },
})

// Define a cached function
cache.define('fetchUser', async (id) => {
  // This will be called only once per unique id within the TTL
  const user = await database.find({ table: 'users', where: { id } })
  return user
})

// Use the cached function
const user = await cache.fetchUser(1)
console.log(user)
```

## Usage

### Basic Setup

You can initialize `CouchbaseStorage` with either a collection or a bucket:

#### Using Collection (Recommended)

```javascript
const collection = bucket.defaultCollection()

const storage = createStorage('custom', {
  storage: new CouchbaseStorage({
    collection, // Pass collection directly
  })
})
```

#### Using Bucket

```javascript
const storage = createStorage('custom', {
  storage: new CouchbaseStorage({
    bucket, // Package will use bucket.defaultCollection()
  })
})
```

### With Invalidation Support

Enable reference-based invalidation to manually invalidate cache entries:

```javascript
const storage = createStorage('custom', {
  storage: new CouchbaseStorage({
    collection,
    invalidation: {
      referencesTTL: 60 // References expire after 60 seconds
    }
  })
})

const cache = createCache({
  ttl: 5,
  storage: {
    type: 'custom',
    options: { storage }
  },
})

// Define function with references
cache.define('fetchUser', {
  references: (args, key, result) => result ? [`user:${result.id}`] : null
}, async (id) => {
  return await database.find({ table: 'users', where: { id } })
})

// Cache will store with reference 'user:1'
await cache.fetchUser(1)

// Invalidate all cache entries for user 1
await cache.invalidateAll('user:1')
```

### Multiple Cache Storages

You can use different storages for different cached functions:

```javascript
const couchbaseStorage = createStorage('custom', {
  storage: new CouchbaseStorage({
    collection,
    invalidation: { referencesTTL: 60 }
  })
})

const cache = createCache({
  ttl: 5,
  storage: {
    type: 'custom',
    options: { storage: couchbaseStorage }
  },
})

// Use Couchbase storage (default)
cache.define('fetchUser', {
  references: (args, key, result) => result ? [`user:${result.id}`] : null
}, (id) => database.find({ table: 'users', where: { id } }))

// Use in-memory storage for this specific function
cache.define('fetchCountries', {
  storage: { type: 'memory', size: 256 },
  references: (args, key, result) => ['countries']
}, () => database.find({ table: 'countries' }))

// Invalidate from default Couchbase storage
await cache.invalidateAll('user:1')

// Invalidate from memory storage
await cache.invalidateAll('countries', 'fetchCountries')
```

## API Reference

### Constructor Options

```javascript
new CouchbaseStorage(options)
```

**Options:**

- `collection` (Object, required if `bucket` not provided): Couchbase collection instance
- `bucket` (Object, required if `collection` not provided): Couchbase bucket instance
- `useHashKeys` (Boolean, default: true): Enable automatic key hashing for long keys
- `maxKeyLength` (Number, default: 200): Maximum key length before hashing (bytes)
- `invalidation` (Object, optional): Invalidation configuration
  - `referencesTTL` (Number, default: 60): TTL for reference keys in seconds
- `log` (Object, optional): Pino-compatible logger instance

### Storage Methods

The storage implements the full `StorageInterface` from async-cache-dedupe:

#### `async get(key)`

Retrieve a value from the cache.

```javascript
const value = await storage.get('cache-key')
```

#### `async set(key, value, ttl, references)`

Store a value in the cache with optional TTL and references.

```javascript
await storage.set('cache-key', { data: 'value' }, 60, ['ref:1', 'ref:2'])
```

#### `async remove(key)`

Remove a value from the cache.

```javascript
await storage.remove('cache-key')
```

#### `async invalidate(references)`

Invalidate cache entries by references.

```javascript
// Single reference
await storage.invalidate('user:1')

// Multiple references
await storage.invalidate(['user:1', 'user:2'])

// Wildcard pattern
await storage.invalidate('user:*')
```

#### `async clear()`

Clear all cache entries.

```javascript
await storage.clear()
```

#### `async refresh(key, ttl)`

Refresh the TTL of a cache entry.

```javascript
await storage.refresh('cache-key', 120)
```

#### `async getTTL(key)`

Get the remaining TTL of a cache entry in seconds.

```javascript
const ttl = await storage.getTTL('cache-key')
console.log(`Expires in ${ttl} seconds`)
```

#### `async exists(key)`

Check if a key exists in the cache.

```javascript
const exists = await storage.exists('cache-key')
console.log(exists ? 'Cache hit' : 'Cache miss')
```

## Invalidation Patterns

### Single Reference Invalidation

```javascript
cache.define('fetchUser', {
  references: (args, key, result) => result ? [`user:${result.id}`] : null
}, async (id) => {
  return await database.find({ table: 'users', where: { id } })
})

// Invalidate specific user
await cache.invalidateAll('user:1')
```

### Multiple References

```javascript
cache.define('fetchUserWithPosts', {
  references: (args, key, result) => {
    if (!result) return null
    return [`user:${result.id}`, `posts:${result.id}`]
  }
}, async (id) => {
  return await database.findUserWithPosts(id)
})

// Invalidate by user reference
await cache.invalidateAll('user:1')

// Or invalidate by posts reference
await cache.invalidateAll('posts:1')
```

### Wildcard Invalidation

```javascript
// Invalidate all users
await cache.invalidateAll('user:*')

// Invalidate specific pattern
await cache.invalidateAll('user:admin:*')
```

### Batch Invalidation

```javascript
// Invalidate multiple references at once
await cache.invalidateAll(['user:1', 'user:2', 'user:3'])
```

## Logging

You can provide a Pino-compatible logger for debugging:

```javascript
const pino = require('pino')
const logger = pino({ level: 'debug' })

const storage = createStorage('custom', {
  storage: new CouchbaseStorage({
    collection,
    log: logger
  })
})
```

Log messages include:
- `cache hit`: When a value is found in cache
- `cache miss`: When a value is not found in cache
- `cache set`: When a value is stored
- `cache remove`: When a value is removed
- `cache invalidate`: When references are invalidated
- `cache cleared`: When all entries are cleared
- `cache refresh`: When a TTL is refreshed
- Various error messages for debugging

## Complete Example

```javascript
const { createStorage, createCache } = require('async-cache-dedupe')
const { CouchbaseStorage } = require('couchbase-cache-dedupe')
const couchbase = require('couchbase')
const pino = require('pino')

async function main() {
  // Connect to Couchbase
  const cluster = await couchbase.connect('couchbase://localhost', {
    username: 'Administrator',
    password: 'password',
  })

  const bucket = cluster.bucket('my_bucket')
  const collection = bucket.defaultCollection()

  // Create logger
  const logger = pino({ level: 'info' })

  // Create storage
  const storage = createStorage('custom', {
    storage: new CouchbaseStorage({
      collection,
      invalidation: { referencesTTL: 300 },
      log: logger
    })
  })

  // Create cache
  const cache = createCache({
    ttl: 60,
    storage: {
      type: 'custom',
      options: { storage }
    },
  })

  // Define cached functions
  cache.define('fetchUser', {
    references: (args, key, result) => result ? [`user:${result.id}`] : null
  }, async (id) => {
    logger.info(`Fetching user ${id} from database`)
    return {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`
    }
  })

  cache.define('fetchUserPosts', {
    references: (args, key, result) => {
      if (!result) return null
      return [`user:${args[0]}`, `posts:user:${args[0]}`]
    }
  }, async (userId) => {
    logger.info(`Fetching posts for user ${userId}`)
    return [
      { id: 1, userId, title: 'Post 1' },
      { id: 2, userId, title: 'Post 2' }
    ]
  })

  // Use the cache
  console.log('First fetch (cache miss):')
  const user1 = await cache.fetchUser(1)
  console.log(user1)

  console.log('\nSecond fetch (cache hit):')
  const user2 = await cache.fetchUser(1)
  console.log(user2)

  console.log('\nFetch user posts:')
  const posts = await cache.fetchUserPosts(1)
  console.log(posts)

  console.log('\nInvalidating user:1...')
  await cache.invalidateAll('user:1')

  console.log('\nThird fetch (cache miss after invalidation):')
  const user3 = await cache.fetchUser(1)
  console.log(user3)

  // Cleanup
  await cluster.close()
}

main().catch(console.error)
```

## Key Hashing

Couchbase has a 250-byte limit on key length. This adapter automatically hashes long keys using SHA-256 to stay within the limit:

- Keys shorter than `maxKeyLength` (default: 200 bytes) are stored as-is
- Keys longer than `maxKeyLength` are hashed using SHA-256
- Hashing can be disabled with `useHashKeys: false` (not recommended)
- Default `maxKeyLength` is 200 bytes (leaving room for prefixes)

```javascript
const storage = new CouchbaseStorage({
  collection,
  maxKeyLength: 150,  // Customize the threshold
  useHashKeys: true   // Enable hashing (default)
})
```

This ensures your application works correctly even with very long cache keys, without manual key management.

## Development Setup

This package includes a complete Docker-based development environment for Couchbase.

### Starting Couchbase with Docker

```bash
# Start Couchbase container
npm run couchbase:start

# Initialize Couchbase (create bucket, scope, collection, authentication)
npm run couchbase:init

# View Couchbase logs
npm run couchbase:logs

# Stop Couchbase
npm run couchbase:stop

# Clean up (removes all data)
npm run couchbase:clean
```

### Default Configuration

The setup script creates the following:
- **Host**: localhost:8091
- **Username**: Administrator
- **Password**: password
- **Bucket**: test-bucket
- **Scope**: test-scope
- **Collection**: test-collection

Access the Couchbase Web Console at http://localhost:8091

### Custom Configuration

You can customize the setup by setting environment variables:

```bash
CB_HOST=localhost \
CB_PORT=8091 \
CB_ADMIN=admin \
CB_PASSWORD=mypassword \
CB_BUCKET=my-bucket \
CB_SCOPE=my-scope \
CB_COLLECTION=my-collection \
npm run couchbase:init
```

## Testing

Run the test suite:

```bash
# Run unit tests (no Couchbase required)
npm test

# Run integration tests (requires Couchbase)
npm run couchbase:start
npm run couchbase:init
npm run test:integration

# Run tests with coverage
npm run test:coverage
```

The package includes comprehensive tests with 100% code coverage, covering:
- All storage interface methods
- TTL handling and expiration
- Reference-based invalidation
- Wildcard pattern matching
- Key hashing for long keys
- Error handling and edge cases
- Integration with async-cache-dedupe and real Couchbase

## Error Handling

The storage handles common Couchbase errors gracefully:

- **DocumentNotFoundError**: Returns `undefined` for get operations, no-op for remove operations
- **Connection errors**: Logged and re-thrown for handling at the application level
- **Reference storage errors**: Logged but don't fail the main operation

## Performance Considerations

1. **TTL**: Couchbase's native TTL is used for automatic expiration, reducing memory usage
2. **References**: Reference keys have their own TTL (`referencesTTL`) to prevent memory leaks
3. **Wildcard invalidation**: Uses N1QL queries which may be slower on large datasets
4. **Logging**: Use appropriate log levels in production to avoid performance impact

## License

MIT

## Related Projects

- [async-cache-dedupe](https://github.com/mcollina/async-cache-dedupe) - The core caching library
- [Couchbase Node.js SDK](https://github.com/couchbase/couchnode) - Official Couchbase SDK
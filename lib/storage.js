
class CouchbaseStorage {
  constructor(options = {}) {
    super()
    
    if (!options.collection && !options.bucket) {
      throw new Error('Either collection or bucket must be provided')
    }

    // If bucket is provided without collection, use default collection
    if (options.bucket && !options.collection) {
      this.collection = options.bucket.defaultCollection()
    } else {
      this.collection = options.collection
    }

    // Store for references mapping
    this.referencesPrefix = 'r:'
    this.valuePrefix = 'v:'
  }

  /**
   * Get a value from Couchbase
   * @param {string} key - The cache key
   * @returns {Promise<Object|null>} The cached value or null if not found
   */
  async get(key) {
    try {
      const result = await this.collection.get(this._getValueKey(key))
      return result.content
    } catch (error) {
      if (error.name === 'DocumentNotFoundError') {
        return null
      }
      throw error
    }
  }

  /**
   * Set a value in Couchbase with TTL and references
   * @param {string} key - The cache key
   * @param {*} value - The value to cache
   * @param {number} ttl - Time to live in seconds
   * @param {Array<string>} references - Array of reference keys
   * @returns {Promise<void>}
   */
  async set(key, value, ttl, references) {
    const valueKey = this._getValueKey(key)
    const expiry = ttl > 0 ? ttl : 0

    // Store the main value with metadata
    const document = {
      value,
      references: references || [],
      createdAt: Date.now()
    }

    await this.collection.upsert(valueKey, document, { expiry })

    // Store references mapping if provided
    if (references && references.length > 0) {
      await this._storeReferences(key, references, ttl)
    }
  }

  /**
   * Remove a value from Couchbase
   * @param {string} key - The cache key
   * @returns {Promise<void>}
   */
  async remove(key) {
    try {
      const valueKey = this._getValueKey(key)
      
      // Get the document to retrieve its references
      const doc = await this.get(key)
      
      // Remove the main document
      await this.collection.remove(valueKey)
      
      // Remove reference mappings
      if (doc && doc.references) {
        await this._removeReferences(key, doc.references)
      }
    } catch (error) {
      if (error.name === 'DocumentNotFoundError') {
        // Already removed, no-op
        return
      }
      throw error
    }
  }

  /**
   * Invalidate cache entries by references
   * @param {string|Array<string>} references - Single reference or array of references
   * @returns {Promise<void>}
   */
  async invalidate(references) {
    const refsArray = Array.isArray(references) ? references : [references]
    
    for (const ref of refsArray) {
      if (ref.includes('*')) {
        // Handle wildcard pattern
        await this._invalidateByPattern(ref)
      } else {
        // Handle exact reference
        await this._invalidateByReference(ref)
      }
    }
  }

  /**
   * Clear all cache entries
   * @returns {Promise<void>}
   */
  async clear() {
    try {
      // Use N1QL query to delete all cache documents
      const cluster = this.collection.scope.bucket.cluster
      const bucketName = this.collection.scope.bucket.name
      const scopeName = this.collection.scope.name
      const collectionName = this.collection.name

      // Build the keyspace path
      const keyspace = scopeName === '_default' && collectionName === '_default'
        ? `\`${bucketName}\``
        : `\`${bucketName}\`.\`${scopeName}\`.\`${collectionName}\``

      // Delete all documents that start with our prefixes
      const query = `
        DELETE FROM ${keyspace}
        WHERE META().id LIKE '${this.valuePrefix}%' OR META().id LIKE '${this.referencesPrefix}%'
      `
      
      await cluster.query(query)
    } catch (error) {
      // If query service not available, fall back to manual deletion
      // This is less efficient but works without query service
      throw new Error('Clear operation requires N1QL query service to be available')
    }
  }

  /**
   * Refresh TTL for a key (not commonly used in Couchbase pattern)
   * @param {string} key - The cache key
   * @returns {Promise<void>}
   */
  async refresh(key) {
    // Get the document
    const doc = await this.get(key)
    if (!doc) {
      return
    }

    // Touch the document to refresh its expiry
    try {
      await this.collection.touch(this._getValueKey(key), doc.ttl || 0)
    } catch (error) {
      if (error.name === 'DocumentNotFoundError') {
        return
      }
      throw error
    }
  }

  /**
   * Get TTL for a key
   * @param {string} key - The cache key
   * @returns {Promise<number>} TTL in seconds
   */
  async getTTL(key) {
    try {
      const result = await this.collection.get(this._getValueKey(key), { withExpiry: true })
      if (result.expiry) {
        const expiryTime = result.expiry * 1000 // Convert to milliseconds
        const now = Date.now()
        const ttl = Math.floor((expiryTime - now) / 1000)
        return ttl > 0 ? ttl : 0
      }
      return 0
    } catch (error) {
      if (error.name === 'DocumentNotFoundError') {
        return 0
      }
      throw error
    }
  }

  /**
   * Check if a key exists
   * @param {string} key - The cache key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    try {
      await this.collection.exists(this._getValueKey(key))
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Store reference mappings
   * @private
   */
  async _storeReferences(key, references, ttl) {
    const promises = references.map(async (ref) => {
      const refKey = this._getReferenceKey(ref)
      try {
        // Get existing reference document or create new one
        let refDoc
        try {
          const result = await this.collection.get(refKey)
          refDoc = result.content
        } catch (error) {
          if (error.name === 'DocumentNotFoundError') {
            refDoc = { keys: [] }
          } else {
            throw error
          }
        }

        // Add the key if not already present
        if (!refDoc.keys.includes(key)) {
          refDoc.keys.push(key)
        }

        const expiry = ttl > 0 ? ttl : 0
        await this.collection.upsert(refKey, refDoc, { expiry })
      } catch (error) {
        // Continue with other references even if one fails
        console.error(`Error storing reference ${ref}:`, error.message)
      }
    })

    await Promise.all(promises)
  }

  /**
   * Remove reference mappings
   * @private
   */
  async _removeReferences(key, references) {
    const promises = references.map(async (ref) => {
      const refKey = this._getReferenceKey(ref)
      try {
        const result = await this.collection.get(refKey)
        const refDoc = result.content

        // Remove the key from the reference
        refDoc.keys = refDoc.keys.filter(k => k !== key)

        if (refDoc.keys.length === 0) {
          // No more keys, remove the reference document
          await this.collection.remove(refKey)
        } else {
          // Update the reference document
          await this.collection.upsert(refKey, refDoc)
        }
      } catch (error) {
        if (error.name === 'DocumentNotFoundError') {
          // Reference already removed
          return
        }
        throw error
      }
    })

    await Promise.all(promises)
  }

  /**
   * Invalidate by exact reference
   * @private
   */
  async _invalidateByReference(reference) {
    const refKey = this._getReferenceKey(reference)
    
    try {
      const result = await this.collection.get(refKey)
      const refDoc = result.content

      // Remove all keys associated with this reference
      const removePromises = refDoc.keys.map(key => this.remove(key))
      await Promise.all(removePromises)

      // Remove the reference document itself
      await this.collection.remove(refKey)
    } catch (error) {
      if (error.name === 'DocumentNotFoundError') {
        // Reference doesn't exist, nothing to invalidate
        return
      }
      throw error
    }
  }

  /**
   * Invalidate by pattern (with wildcard)
   * @private
   */
  async _invalidateByPattern(pattern) {
    try {
      const cluster = this.collection.scope.bucket.cluster
      const bucketName = this.collection.scope.bucket.name
      const scopeName = this.collection.scope.name
      const collectionName = this.collection.name

      // Build the keyspace path
      const keyspace = scopeName === '_default' && collectionName === '_default'
        ? `\`${bucketName}\``
        : `\`${bucketName}\`.\`${scopeName}\`.\`${collectionName}\``

      // Convert wildcard pattern to SQL LIKE pattern
      const searchPattern = this.referencesPrefix + pattern.replace(/\*/g, '%')
      
      // Query to find all matching reference documents
      const query = `
        SELECT META().id, * FROM ${keyspace}
        WHERE META().id LIKE '${searchPattern}'
      `
      
      const result = await cluster.query(query)
      
      // Invalidate each matching reference
      for (const row of result.rows) {
        const refDoc = row[collectionName] || row
        if (refDoc.keys && Array.isArray(refDoc.keys)) {
          const removePromises = refDoc.keys.map(key => this.remove(key))
          await Promise.all(removePromises)
          
          // Remove the reference document
          const docId = row.id
          await this.collection.remove(docId)
        }
      }
    } catch (error) {
      // If query service not available, we cannot handle wildcards
      throw new Error('Wildcard invalidation requires N1QL query service to be available')
    }
  }

  /**
   * Get prefixed value key
   * @private
   */
  _getValueKey(key) {
    return `${this.valuePrefix}${key}`
  }

  /**
   * Get prefixed reference key
   * @private
   */
  _getReferenceKey(reference) {
    return `${this.referencesPrefix}${reference}`
  }
}

module.exports = CouchbaseStorage

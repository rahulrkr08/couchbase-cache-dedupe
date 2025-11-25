#!/bin/bash

set -e

# Configuration
CB_HOST=${CB_HOST:-localhost}
CB_PORT=${CB_PORT:-8091}
CB_ADMIN=${CB_ADMIN:-Administrator}
CB_PASSWORD=${CB_PASSWORD:-password}
CB_BUCKET=${CB_BUCKET:-test-bucket}
CB_RAMSIZE=${CB_RAMSIZE:-512}
CB_SCOPE=${CB_SCOPE:-test-scope}
CB_COLLECTION=${CB_COLLECTION:-test-collection}

echo "Waiting for Couchbase to be ready..."
# Wait for Couchbase to be ready (max 60 seconds)
max_attempts=60
attempt=0
while [ $attempt -lt $max_attempts ]; do
  if curl -s http://${CB_HOST}:${CB_PORT}/ui/index.html > /dev/null 2>&1; then
    echo "Couchbase is ready!"
    break
  fi
  attempt=$((attempt + 1))
  echo "Waiting... ($attempt/$max_attempts)"
  sleep 1
done

if [ $attempt -eq $max_attempts ]; then
  echo "Error: Couchbase failed to start within the expected time"
  exit 1
fi

echo "Initializing Couchbase cluster..."
# Initialize the cluster
couchbase-cli cluster-init \
  --cluster ${CB_HOST}:${CB_PORT} \
  --cluster-username ${CB_ADMIN} \
  --cluster-password ${CB_PASSWORD} \
  --services data,index,query \
  --cluster-ramsize ${CB_RAMSIZE} \
  --cluster-index-ramsize 256 \
  --index-storage-setting default || echo "Cluster already initialized"

# Wait a bit for services to be ready
sleep 5

echo "Creating bucket '${CB_BUCKET}'..."
# Create bucket
couchbase-cli bucket-create \
  --cluster ${CB_HOST}:${CB_PORT} \
  --username ${CB_ADMIN} \
  --password ${CB_PASSWORD} \
  --bucket ${CB_BUCKET} \
  --bucket-type couchbase \
  --bucket-ramsize ${CB_RAMSIZE} \
  --enable-flush 1 || echo "Bucket may already exist"

# Wait for bucket to be ready
echo "Waiting for bucket to be ready..."
sleep 5

echo "Creating scope '${CB_SCOPE}'..."
# Create scope
couchbase-cli collection-manage \
  --cluster ${CB_HOST}:${CB_PORT} \
  --username ${CB_ADMIN} \
  --password ${CB_PASSWORD} \
  --bucket ${CB_BUCKET} \
  --create-scope ${CB_SCOPE} || echo "Scope may already exist"

sleep 2

echo "Creating collection '${CB_COLLECTION}'..."
# Create collection
couchbase-cli collection-manage \
  --cluster ${CB_HOST}:${CB_PORT} \
  --username ${CB_ADMIN} \
  --password ${CB_PASSWORD} \
  --bucket ${CB_BUCKET} \
  --create-collection ${CB_SCOPE}.${CB_COLLECTION} || echo "Collection may already exist"

# Wait for collection to be ready
sleep 3

echo "Creating primary index for query support..."
# Create primary index for N1QL queries
curl -u ${CB_ADMIN}:${CB_PASSWORD} \
  -X POST http://${CB_HOST}:8093/query/service \
  -d "statement=CREATE PRIMARY INDEX ON \`${CB_BUCKET}\`.\`${CB_SCOPE}\`.\`${CB_COLLECTION}\`" || echo "Index may already exist"

sleep 2

echo ""
echo "================================================"
echo "Couchbase setup completed successfully!"
echo "================================================"
echo "Connection details:"
echo "  Host: ${CB_HOST}:${CB_PORT}"
echo "  Username: ${CB_ADMIN}"
echo "  Password: ${CB_PASSWORD}"
echo "  Bucket: ${CB_BUCKET}"
echo "  Scope: ${CB_SCOPE}"
echo "  Collection: ${CB_COLLECTION}"
echo "================================================"
echo ""
echo "You can access the Couchbase Web Console at:"
echo "  http://${CB_HOST}:${CB_PORT}"
echo ""

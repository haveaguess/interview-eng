import { LevelUp, LevelUpChain } from 'levelup';
import { HashPath } from './hash_path';
import { Sha256Hasher } from './sha256_hasher';

// Maximum depth of the tree. With depth 32, the tree can store 2^32 elements
const MAX_DEPTH = 32;
// Size of each hash in bytes (SHA-256 produces 32-byte hashes)
const HASH_BYTES = 32;
// Size of leaf values in bytes. Each leaf stores 64 bytes of data
const LEAF_BYTES = 64;

/**
 * The merkle tree, in summary, is a data structure with a number of indexable elements, and the property
 * that it is possible to provide a succinct proof (HashPath) that a given piece of data, exists at a certain index,
 * for a given merkle tree root.
 * 
 * ## Merkle Tree Structure

    - The merkle tree is of depth `32`, and is fully formed with leaves consisting of `64` zero bytes at every index.
    - When inserting an element of arbitrary length, the value must first be `hash`ed to `32` bytes using sha256.
    - Each node of the tree is computed by `compress`ing its left and right subtree hashes and taking the resulting sha256 hash.
    - For reference, an unpopulated merkle tree will have a root hash of `1c9a7e5ff1cf48b4ad1582d3f4e4a1004f3b20d8c5a2b71387a4254ad933ebc5`.

    The merkle tree is to be persisted in a key value store. `LevelUp` provides the basic key value store interface.

 */
export class MerkleTree {
  // Hasher for creating leaf hashes and combining internal nodes
  private hasher = new Sha256Hasher();
  // Current root hash of the tree
  private root: Buffer = Buffer.alloc(HASH_BYTES);
  // // Map to store modified leaf values (sparse representation)
  // private dataMap = new Map<number, Buffer>();
  private nodeCache = new Map<string, Buffer>();

  /**
   * Constructs a new MerkleTree instance, either initializing an empty tree, or restoring pre-existing state values.
   * Use the async static `new` function to construct.
   *
   * @param db Underlying leveldb.
   * @param name Name of the tree, to be used when restoring/persisting state.
   * @param depth The depth of the tree, to be no greater than MAX_DEPTH.
   * @param root When restoring, you need to provide the root.
   */
  constructor(private db: LevelUp, private name: string, private depth: number, root?: Buffer) {
    if (!(depth >= 1 && depth <= MAX_DEPTH)) {
      throw Error('Bad depth');
    }

    // Precompute empty tree hashes first for better performance
    this.precomputeEmptyTreeHashes();

    if (root) {
      // If restoring existing tree, use provided root
      this.root = root;
    } else {
      // For new tree, get the root hash of empty tree from cached values
      this.root = this.calculateEmptyTreeRoot();
    }
  }

  /**
   * Efficiently retrieves the root hash of an empty tree with all zero leaves.
   * Uses the precomputed values to avoid duplicate calculations.
   */
  private calculateEmptyTreeRoot(): Buffer {
    // Simply return the cached root hash for the tree's depth
    // Non-null assertion (!) is safe here because precomputeEmptyTreeHashes()
    // is always called in the constructor before this method
    return this.nodeCache.get(`zero:${this.depth}`)!;
  }

  /**
   * Constructs or restores a new MerkleTree instance with the given `name` and `depth`.
   * The `db` contains the tree data.
   */
  static async new(db: LevelUp, name: string, depth = MAX_DEPTH) {
    const meta: Buffer = await db.get(Buffer.from(name)).catch(() => {});
    if (meta) {
      const root = meta.slice(0, HASH_BYTES);
      const depth = meta.readUInt32LE(32);
      return new MerkleTree(db, name, depth, root);
    } else {
      const tree = new MerkleTree(db, name, depth);
      await tree.writeMetaData();
      return tree;
    }
  }

  private async writeMetaData(batch?: LevelUpChain<string, Buffer>) {
    const data = Buffer.alloc(40);
    this.root.copy(data);
    data.writeUInt32LE(this.depth, 32);
    if (batch) {
      batch.put(this.name, data);
    } else {
      await this.db.put(this.name, data);
    }
  }

  getRoot() {
    return this.root;
  }

  /**
   * Precomputes and caches all empty tree hashes up to the specified depth.
   * This improves performance for operations on sparse trees.
   */
  private precomputeEmptyTreeHashes(): void {
    // Calculate and cache empty leaf hash
    const emptyLeafHash = this.hasher.hash(Buffer.alloc(LEAF_BYTES));
    this.nodeCache.set('zero:0', emptyLeafHash);
    
    // Calculate and cache all level hashes
    for (let level = 1; level <= this.depth; level++) {
      const prevLevelHash = this.nodeCache.get(`zero:${level-1}`)!;
      const levelHash = this.hasher.compress(prevLevelHash, prevLevelHash);
      this.nodeCache.set(`zero:${level}`, levelHash);
    }
  }

  /**
   * Returns the hash path for `index`.
   * e.g. To return the HashPath for index 2, return the nodes marked `*` at each layer.
   *     d3:                                            [ root ]
   *     d2:                      [*]                                               [*]
   *     d1:         [*]                      [*]                       [ ]                     [ ]
   *     d0:   [ ]         [ ]          [*]         [*]           [ ]         [ ]          [ ]        [ ]
   */
  async getHashPath(index: number) {
    // For large depths, use Math.pow instead of bit shifting to prevent overflow
    if (index < 0 || index >= Math.pow(2, this.depth)) {
      throw new Error(`Index ${index} out of range for tree of depth ${this.depth}`);
    }

    // Make sure we have all empty tree hashes precomputed
    if (!this.nodeCache.has(`zero:${this.depth}`)) {
      this.precomputeEmptyTreeHashes();
    }

    const path = [];
    let levelIndex = index;
    
    // Build path from leaf to root
    for (let level = 0; level < this.depth; level++) {
      // At each level, find the sibling node's hash
      const isRight = levelIndex % 2 !== 0;
      const siblingIndex = isRight ? levelIndex - 1 : levelIndex + 1;
      
      // Get both the current node's hash and its sibling's hash in parallel for efficiency
      const [currentHash, siblingHash] = await Promise.all([
        this.getNodeHash(level, levelIndex),
        this.getNodeHash(level, siblingIndex)
      ]);
      
      // Store hashes in correct order (left then right)
      const pair = isRight ? [siblingHash, currentHash] : [currentHash, siblingHash];
      path.push(pair);
      
      // Move up to parent level
      levelIndex = Math.floor(levelIndex / 2);
    }
    
    return new HashPath(path);
  }

  /**
   * Gets or calculates the hash for any node in the tree.
   * - For leaves (level 0): returns stored hash or hash of zeros if not set
   * - For internal nodes: returns stored hash or calculates from children
   */
  private async getNodeHash(level: number, index: number): Promise<Buffer> {
    // Use cache if available
    const cacheKey = `${level}:${index}`;
    if (this.nodeCache.has(cacheKey)) {
      return this.nodeCache.get(cacheKey)!;
    }

    let hash: Buffer;
    // Unified naming convention - all nodes use node:level:index format
    const nodeKey = `node:${level}:${index}`;
    
    try {
      // Attempt to retrieve the node from database
      hash = await this.db.get(Buffer.from(nodeKey));
    } catch (e) {
      // If node not found in database, calculate it
      if (level === 0) {
        // Level 0 nodes (leaves) use empty LEAF_BYTES when not set
        hash = this.hasher.hash(Buffer.alloc(LEAF_BYTES));
      } else {
        // Calculate parent hash by getting and combining child hashes
        const leftChildIndex = index * 2;
        const rightChildIndex = leftChildIndex + 1;
        
        const leftHash = await this.getNodeHash(level - 1, leftChildIndex);
        const rightHash = await this.getNodeHash(level - 1, rightChildIndex);
        
        hash = this.hasher.compress(leftHash, rightHash);
      }
    }
    
    // Cache the result for future use
    this.nodeCache.set(cacheKey, hash);
    return hash;
  }

  /**
   * Updates a leaf value and recalculates all affected hashes up to the root.
   * Uses batch operations to ensure atomic updates to the database.
   */
  async updateElement(index: number, value: Buffer) {
    // Fix bounds check - for a tree of depth N, valid indices are 0 to 2^N - 1
    if (index < 0 || index >= Math.pow(2, this.depth)) {
      throw new Error(`Index ${index} out of range for tree of depth ${this.depth}`);
    }

    // Clear cache before update
    this.nodeCache.clear();
    
    // Ensure zero hashes are pre-calculated for better performance
    this.precomputeEmptyTreeHashes();
    
    // Start a batch of database operations
    const batch = this.db.batch();
    
    // Calculate all necessary hashes in memory first
    const leafHash = this.hasher.hash(value);
    
    // Store leaf hash in database using unified naming convention
    const leafKey = `node:0:${index}`; // Level 0 = leaf nodes
    batch.put(Buffer.from(leafKey), leafHash);
    
    // Pre-calculate all the hashes up the tree
    const nodes: Buffer[] = new Array(this.depth);
    let currentHash = leafHash;
    let currentIndex = index;
    
    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 !== 0;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      
      // Get sibling hash with optimized approach
      let siblingHash: Buffer;
      const siblingKey = `${level}:${siblingIndex}`;
      
      if (this.nodeCache.has(siblingKey)) {
        siblingHash = this.nodeCache.get(siblingKey)!;
      } else {
        // Try getting from database directly
        const siblingNodeKey = `node:${level}:${siblingIndex}`;
        try {
          siblingHash = await this.db.get(Buffer.from(siblingNodeKey));
        } catch (e) {
          // If not in database, use empty hash value
          if (level === 0) {
            siblingHash = this.hasher.hash(Buffer.alloc(LEAF_BYTES));
          } else {
            siblingHash = this.calculateZeroHashAtLevel(level);
          }
        }
        // Cache for future use
        this.nodeCache.set(siblingKey, siblingHash);
      }
      
      // Calculate parent hash (order matters - left then right)
      currentHash = isRight
        ? this.hasher.compress(siblingHash, currentHash)
        : this.hasher.compress(currentHash, siblingHash);
      
      // Save the hash for this level
      nodes[level] = currentHash;
      
      // Move up to parent level
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    // Now save all the internal nodes to database using unified naming
    currentIndex = index;
    for (let level = 0; level < this.depth - 1; level++) {
      currentIndex = Math.floor(currentIndex / 2);
      const nodeKey = `node:${level + 1}:${currentIndex}`;
      batch.put(Buffer.from(nodeKey), nodes[level]);
    }
    
    // Update root
    this.root = nodes[this.depth - 1];
    
    // Write metadata
    await this.writeMetaData(batch);
    
    // Execute all updates in one batch
    await batch.write();
    
    return this.root;
  }
  
  private calculateZeroHashAtLevel(level: number): Buffer {
    return this.nodeCache.get(`zero:${level}`)!;
  }

  /**
   * Calculate the levenshtein distance between two strings. Not always necessary.
   */
  static levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // Initialize first row
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    // Initialize first column
    for (let i = 0; i <= a.length; i++) {
      matrix[0][i] = i;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}

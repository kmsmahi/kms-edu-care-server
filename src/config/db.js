import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

/**
 * Collections are exported as live bindings: they are `null` until
 * connectDB() resolves, then point at the real collections everywhere
 * they are imported. The connection is cached, so calling connectDB()
 * repeatedly (e.g. on every serverless cold start) is safe.
 */
export let users = null;
export let tuitions = null;
export let applications = null;
export let payments = null;

let client = null;
let db = null;
let connectionPromise = null;

/** Creates the indexes that enforce uniqueness and speed up common queries. */
const ensureIndexes = async () => {
  try {
    await Promise.all([
      users.createIndex({ email: 1 }, { unique: true }),

      tuitions.createIndex({ status: 1, createdAt: -1 }),
      tuitions.createIndex({ studentEmail: 1 }),

      // A tutor can apply to a given tuition only once
      applications.createIndex({ tuitionId: 1, tutorEmail: 1 }, { unique: true }),
      applications.createIndex({ tutorEmail: 1 }),

      // A Stripe payment can be recorded only once (idempotent confirmation)
      payments.createIndex({ paymentIntentId: 1 }, { unique: true }),
      payments.createIndex({ studentEmail: 1 }),
      payments.createIndex({ tutorEmail: 1 }),
    ]);
  } catch (error) {
    // Existing duplicate data can block a unique index; don't crash the server over it
    console.warn("Index creation warning:", error.message);
  }
};

/** Connects to MongoDB once and wires up the collection exports. */
export const connectDB = async () => {
  if (connectionPromise) return connectionPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not defined in the environment variables");
  }

  connectionPromise = (async () => {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
    });

    await client.connect();
    db = client.db(process.env.DB_NAME || "kms_educare");

    users = db.collection("users");
    tuitions = db.collection("tuitions");
    applications = db.collection("applications");
    payments = db.collection("payments");

    await ensureIndexes();
    console.log("MongoDB connected");
    return db;
  })().catch((error) => {
    connectionPromise = null; // allow a retry on the next call
    throw error;
  });

  return connectionPromise;
};

/** Returns the connected database (throws if connectDB() has not completed). */
export const getDB = () => {
  if (!db) throw new Error("Database is not connected yet");
  return db;
};

/** Closes the connection (used for graceful shutdown). */
export const closeDB = async () => {
  if (client) {
    await client.close();
    client = null;
    db = null;
    connectionPromise = null;
  }
};

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

/** True only for a valid 24-character hex ObjectId string. */
export const isValidObjectId = (id) =>
  typeof id === "string" && OBJECT_ID_PATTERN.test(id);

/** Converts a string to an ObjectId, or returns null when it is not a valid id. */
export const toObjectId = (id) => (isValidObjectId(id) ? new ObjectId(id) : null);

export { ObjectId };
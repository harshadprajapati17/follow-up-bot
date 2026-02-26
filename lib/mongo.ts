import { MongoClient, Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const DEFAULT_DB_NAME = process.env.MONGODB_DB_NAME || 'conversation-bot';

let mongoClient: MongoClient | null = null;
let mongoClientPromise: Promise<MongoClient> | null = null;

export async function getMongoClient(): Promise<MongoClient | null> {
  if (!MONGODB_URI) {
    console.warn('[mongo] MONGODB_URI not set, skipping MongoDB connection');
    return null;
  }

  if (!mongoClientPromise) {
    mongoClientPromise = MongoClient.connect(MONGODB_URI).then(
      (connectedClient: MongoClient) => {
        mongoClient = connectedClient;
        return connectedClient;
      }
    );
  }

  try {
    return await mongoClientPromise;
  } catch (err) {
    console.error('[mongo] Failed to connect to MongoDB:', err);
    return null;
  }
}

export async function getMongoDb(dbName: string = DEFAULT_DB_NAME): Promise<Db | null> {
  const client = await getMongoClient();
  if (!client) return null;
  return client.db(dbName);
}

/**
 * Persists a completed /project conversation to MongoDB (project_conversations collection).
 * Called from the webhook route when the user answers हाँ/नहीं.
 */
export async function saveProjectConversation(params: {
  chatId: number;
  firstName?: string;
  messageDate?: number | null;
  payload: {
    work_location: string | null;
    rooms_count: string | null;
    assign_resources: boolean;
  };
}): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  const collection = db.collection('project_conversations');
  const { chatId, firstName, messageDate, payload } = params;

  const doc = {
    chatId,
    firstName: firstName ?? null,
    work_location: payload.work_location,
    rooms_count: payload.rooms_count,
    assign_resources: payload.assign_resources,
    messageDate: messageDate != null ? new Date(messageDate * 1000) : null,
    createdAt: new Date(),
  };

  try {
    await collection.insertOne(doc);
    console.log('[mongo] Saved project conversation for chat', chatId);
  } catch (err) {
    console.error('[mongo] Failed to save project conversation:', err);
  }
}


import { MongoClient, Db, ObjectId } from 'mongodb';

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

export async function getRecentLeadsForUser(params: {
  userId: string;
  limit?: number;
}): Promise<LeadSummary[]> {
  const db = await getMongoDb();
  if (!db) return [];

  const { userId, limit = 5 } = params;

  try {
    const collection = db.collection<LeadDocument>('leads');
    const cursor = collection
      .find(
        { userId },
        {
          projection: {
            customer_name: 1,
            customer_phone: 1,
            location_text: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .limit(limit);

    const docs = await cursor.toArray();

    return docs.map((doc) => ({
      id: doc._id ? doc._id.toHexString() : '',
      customer_name: doc.customer_name ?? null,
      customer_phone: doc.customer_phone ?? null,
      location_text: doc.location_text ?? null,
      createdAt: doc.createdAt,
    }));
  } catch (err) {
    console.error('[mongo] Failed to fetch recent leads for user:', err);
    return [];
  }
}

type LeadEntities = Record<string, unknown>;

export interface LeadDocument {
  _id?: ObjectId;
  userId: string;
  contractor_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  location_text: string | null;
  job_scope: string | null;
  property_size_type: string | null;
  property_area_sqft: number | null;
  is_repaint: boolean | null;
  start_timing: string | null;
  start_date: Date | null;
  /** Brand preference captured at lead level (e.g. Asian Paints, Berger) */
  brand_preference?: string | null;
  finish_quality: string | null;
  site_visit_preference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VisitDocument {
  _id?: ObjectId;
  leadId: ObjectId;
  date: string | null;
  time: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VisitDetails {
  date: string | null;
  time: string | null;
}

export interface MeasurementDocument {
  _id?: ObjectId;
  leadId: ObjectId;
  measurement_area: string | null;
  measurements?: unknown;
  /** Whether ceiling is included in painting scope */
  ceiling_included?: boolean | null;
  /** Number of putty coats (0, 1, or 2) */
  putty_coats?: number | null;
  /** Whether primer is included */
  primer_included?: boolean | null;
  /** Whether old paint scraping is required */
  scrape_required?: boolean | null;
  /** Damp/seepage issue description, or 'none' */
  damp_issue?: string | null;
  /** Putty/primer detail, e.g. '1 coat putty, 1 coat primer' */
  prep_level?: string | null;
  /** Paint brand preference, e.g. 'Asian Paints', 'no preference' */
  brand_preference?: string | null;
  /** Finish type: matt, satin, gloss, or texture */
  finish?: string | null;
  /**
   * Structured list of issues captured during LOG_MEASUREMENT, if any.
   * Shape is controlled at the orchestrator/LLM layer and stored as-is.
   */
  issues?: unknown;
  /**
   * Recommended painter add-ons inferred from issues/symptoms during LOG_MEASUREMENT.
   * E.g. damp treatment, crack repair, terrace waterproofing, etc.
   * Shape is controlled at the orchestrator/LLM layer and stored as-is.
   */
  recommended_addons?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeasurementDetails {
  measurement_area: string | null;
  measurements?: unknown;
  ceiling_included?: boolean | null;
  putty_coats?: number | null;
  primer_included?: boolean | null;
  scrape_required?: boolean | null;
  damp_issue?: string | null;
  prep_level?: string | null;
  brand_preference?: string | null;
  finish?: string | null;
  issues?: unknown;
  recommended_addons?: unknown;
}

export interface LeadSummary {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  location_text: string | null;
  createdAt: Date;
}

export interface LeadDetails extends LeadDocument {
  id: string;
}

/**
 * Fetch a single lead for a given user by its Mongo ObjectId string.
 * Returns a lightweight summary or null if not found / invalid.
 */
export async function getLeadByIdForUser(params: {
  userId: string;
  leadId: string;
}): Promise<LeadSummary | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const { userId, leadId } = params;
  const objectId = toObjectId(leadId);
  if (!objectId) return null;

  try {
    const collection = db.collection<LeadDocument>('leads');
    const doc = await collection.findOne(
      { _id: objectId, userId },
      {
        projection: {
          customer_name: 1,
          customer_phone: 1,
          location_text: 1,
          createdAt: 1,
        },
      }
    );

    if (!doc) {
      return null;
    }

    return {
      id: doc._id ? doc._id.toHexString() : '',
      customer_name: doc.customer_name ?? null,
      customer_phone: doc.customer_phone ?? null,
      location_text: doc.location_text ?? null,
      createdAt: doc.createdAt,
    };
  } catch (err) {
    console.error('[mongo] Failed to fetch lead by id for user:', err);
    return null;
  }
}

/**
 * Fetch visit schedule (date/time) for a given lead.
 * Returns null if no visit is found or on error.
 */
export async function getVisitForLead(params: {
  leadId: string;
}): Promise<VisitDetails | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const objectId = toObjectId(params.leadId);
  if (!objectId) return null;

  try {
    const collection = db.collection<VisitDocument>('lead_visits');
    const doc = await collection.findOne({ leadId: objectId });
    if (!doc) return null;

    return {
      date: doc.date ?? null,
      time: doc.time ?? null,
    };
  } catch (err) {
    console.error('[mongo] Failed to fetch visit for lead:', err);
    return null;
  }
}

/**
 * Fetch measurement / scope details for a given lead.
 * Returns null if no measurement is found or on error.
 */
export async function getMeasurementForLead(params: {
  leadId: string;
}): Promise<MeasurementDetails | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const objectId = toObjectId(params.leadId);
  if (!objectId) return null;

  try {
    const collection = db.collection<MeasurementDocument>('lead_measurements');
    const doc = await collection.findOne({ leadId: objectId });
    if (!doc) return null;

    return {
      measurement_area: doc.measurement_area ?? null,
      measurements: doc.measurements,
      ceiling_included: doc.ceiling_included ?? null,
      putty_coats: doc.putty_coats ?? null,
      primer_included: doc.primer_included ?? null,
      scrape_required: doc.scrape_required ?? null,
      damp_issue: doc.damp_issue ?? null,
      prep_level: doc.prep_level ?? null,
      brand_preference: doc.brand_preference ?? null,
      finish: doc.finish ?? null,
      issues: doc.issues,
      recommended_addons: doc.recommended_addons,
    };
  } catch (err) {
    console.error('[mongo] Failed to fetch measurement for lead:', err);
    return null;
  }
}

/**
 * Fetch the full lead document (all fields) for a given user + lead id.
 * Used for read-only "lead details" style summaries.
 */
export async function getLeadDetailsForUser(params: {
  userId: string;
  leadId: string;
}): Promise<LeadDetails | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const { userId, leadId } = params;
  const objectId = toObjectId(leadId);
  if (!objectId) return null;

  try {
    const collection = db.collection<LeadDocument>('leads');
    const doc = await collection.findOne({ _id: objectId, userId });
    if (!doc) return null;

    const { _id, ...rest } = doc;
    return {
      ...(rest as LeadDocument),
      id: _id ? _id.toHexString() : leadId,
    };
  } catch (err) {
    console.error('[mongo] Failed to fetch full lead details for user:', err);
    return null;
  }
}

function toObjectId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    console.warn('[mongo] Invalid ObjectId string received:', id);
    return null;
  }
}

function getString(entities: LeadEntities, key: string): string | null {
  const value = entities[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getBoolean(entities: LeadEntities, key: string): boolean | null {
  const value = entities[key];
  if (typeof value === 'boolean') return value;
  return null;
}

function getNumber(entities: LeadEntities, key: string): number | null {
  const value = entities[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getDateFromString(entities: LeadEntities, key: string): Date | null {
  const value = entities[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Create a new lead document in MongoDB from normalized entities.
 * Returns the created lead's string id (Mongo ObjectId) or null on failure.
 */
export async function createLeadFromEntities(params: {
  userId: string;
  entities: LeadEntities;
}): Promise<string | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const collection = db.collection<LeadDocument>('leads');
  const { userId, entities } = params;
  const now = new Date();

  const doc: LeadDocument = {
    userId,
    contractor_id: getString(entities, 'contractor_id'),
    customer_name: getString(entities, 'customer_name'),
    customer_phone: getString(entities, 'customer_phone'),
    location_text: getString(entities, 'location_text'),
    job_scope: getString(entities, 'job_scope'),
    property_size_type: getString(entities, 'property_size_type'),
    property_area_sqft: getNumber(entities, 'property_area_sqft'),
    is_repaint: getBoolean(entities, 'is_repaint'),
    brand_preference: getString(entities, 'brand_preference'),
    start_timing: getString(entities, 'start_timing'),
    start_date: getDateFromString(entities, 'start_date'),
    finish_quality: getString(entities, 'finish_quality'),
    site_visit_preference: getString(entities, 'site_visit_preference'),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await collection.insertOne(doc);
    const id = result.insertedId.toHexString();
    console.log('[mongo] Created lead', id);
    return id;
  } catch (err) {
    console.error('[mongo] Failed to create lead:', err);
    return null;
  }
}

/**
 * Update an existing lead document in MongoDB from normalized entities.
 * Only non-null fields are applied. Silently no-ops on invalid id.
 */
export async function updateLeadFromEntities(params: {
  leadId: string;
  entities: LeadEntities;
}): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  const objectId = toObjectId(params.leadId);
  if (!objectId) return;

  const collection = db.collection<LeadDocument>('leads');
  const { entities } = params;
  const now = new Date();

  const update: Partial<LeadDocument> = {};

  const contractorId = getString(entities, 'contractor_id');
  if (contractorId !== null) update.contractor_id = contractorId;

  const customerName = getString(entities, 'customer_name');
  if (customerName !== null) update.customer_name = customerName;

  const customerPhone = getString(entities, 'customer_phone');
  if (customerPhone !== null) update.customer_phone = customerPhone;

  const locationText = getString(entities, 'location_text');
  if (locationText !== null) update.location_text = locationText;

  const jobScope = getString(entities, 'job_scope');
  if (jobScope !== null) update.job_scope = jobScope;

  const propertySizeType = getString(entities, 'property_size_type');
  if (propertySizeType !== null) update.property_size_type = propertySizeType;

  const propertyAreaSqft = getNumber(entities, 'property_area_sqft');
  if (propertyAreaSqft !== null) update.property_area_sqft = propertyAreaSqft;

  const isRepaint = getBoolean(entities, 'is_repaint');
  if (isRepaint !== null) update.is_repaint = isRepaint;

  const startTiming = getString(entities, 'start_timing');
  if (startTiming !== null) update.start_timing = startTiming;

  const startDate = getDateFromString(entities, 'start_date');
  if (startDate !== null) update.start_date = startDate;

  const finishQuality = getString(entities, 'finish_quality');
  if (finishQuality !== null) update.finish_quality = finishQuality;

  const siteVisitPreference = getString(entities, 'site_visit_preference');
  if (siteVisitPreference !== null) {
    update.site_visit_preference = siteVisitPreference;
  }

  if (Object.keys(update).length === 0) {
    return;
  }

  update.updatedAt = now;

  try {
    await collection.updateOne(
      { _id: objectId },
      {
        $set: update,
      }
    );
    console.log('[mongo] Updated lead', params.leadId);
  } catch (err) {
    console.error('[mongo] Failed to update lead:', err);
  }
}

/**
 * Upsert a visit document for the given lead based on entities.
 * Ensures we always target the same leadId and never touch other leads.
 */
export async function upsertVisitFromEntities(params: {
  leadId: string;
  entities: LeadEntities;
}): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  const objectId = toObjectId(params.leadId);
  if (!objectId) return;

  const collection = db.collection<VisitDocument>('lead_visits');
  const { entities } = params;
  const now = new Date();

  const date = getString(entities, 'date');
  const time = getString(entities, 'time');

  const update: Partial<VisitDocument> = {
    updatedAt: now,
  };

  if (date !== null) update.date = date;
  if (time !== null) update.time = time;

  try {
    await collection.updateOne(
      { leadId: objectId },
      {
        $set: update,
        $setOnInsert: {
          leadId: objectId,
          createdAt: now,
        },
      },
      { upsert: true }
    );
    console.log('[mongo] Upserted visit for lead', params.leadId);
  } catch (err) {
    console.error('[mongo] Failed to upsert visit:', err);
  }
}

/**
 * Upsert a measurement document for the given lead based on entities.
 * Subsequent LOG_MEASUREMENT steps for the same leadId will update the same
 * record, avoiding any cross-lead overwrites.
 */
export async function upsertMeasurementFromEntities(params: {
  leadId: string;
  entities: LeadEntities;
}): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  const objectId = toObjectId(params.leadId);
  if (!objectId) return;

  const collection = db.collection<MeasurementDocument>('lead_measurements');
  const { entities } = params;
  const now = new Date();

  const measurementArea = getString(entities, 'measurement_area');
  const measurements = entities['measurements'];
  const ceilingIncluded = getBoolean(entities, 'ceiling_included');
  const puttyCoats = getNumber(entities, 'putty_coats');
  const primerIncluded = getBoolean(entities, 'primer_included');
  const scrapeRequired = getBoolean(entities, 'scrape_required');
  const dampIssue = getString(entities, 'damp_issue');
  const prepLevel = getString(entities, 'prep_level');
  const brandPreference = getString(entities, 'brand_preference');
  const finish = getString(entities, 'finish');
  const issues = entities['issues'];
  const recommendedAddons = entities['recommended_addons'];

  const update: Partial<MeasurementDocument> = {
    updatedAt: now,
  };

  if (measurementArea !== null) update.measurement_area = measurementArea;
  if (measurements !== undefined) update.measurements = measurements;
  if (ceilingIncluded !== null) update.ceiling_included = ceilingIncluded;
  if (puttyCoats !== null) update.putty_coats = puttyCoats;
  if (primerIncluded !== null) update.primer_included = primerIncluded;
  if (scrapeRequired !== null) update.scrape_required = scrapeRequired;
  if (dampIssue !== null) update.damp_issue = dampIssue;
  if (prepLevel !== null) update.prep_level = prepLevel;
  if (brandPreference !== null) update.brand_preference = brandPreference;
  if (finish !== null) update.finish = finish;
  if (issues !== undefined) update.issues = issues;
  if (recommendedAddons !== undefined) update.recommended_addons = recommendedAddons;

  try {
    await collection.updateOne(
      { leadId: objectId },
      {
        $set: update,
        $setOnInsert: {
          leadId: objectId,
          createdAt: now,
        },
      },
      { upsert: true }
    );
    console.log('[mongo] Upserted measurement for lead', params.leadId);
  } catch (err) {
    console.error('[mongo] Failed to upsert measurement:', err);
  }
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


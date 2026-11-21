import { applications, tuitions, users, toObjectId } from "../config/db.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

// Must match CLASS_LEVELS in the client (Components/Tutions/TuitionFiltersBar.jsx)
export const CLASS_LEVELS = [
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5",
  "Class 6", "Class 7", "Class 8", "Class 9", "Class 10",
  "Class 11", "Class 12", "Admission Test", "University",
];

const MAX_BUDGET = 10_000_000;

const cleanString = (value) => (typeof value === "string" ? value.trim() : "");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

// Public responses never expose the student's email
const PUBLIC_PROJECTION = { studentEmail: 0 };

const SORTS = {
  date_desc: { createdAt: -1, _id: -1 },
  date_asc: { createdAt: 1, _id: 1 },
  budget_asc: { budget: 1, createdAt: -1 },
  budget_desc: { budget: -1, createdAt: -1 },
};

/**
 * Validates tuition input. With { partial: true } (edits) only the fields that
 * were sent are checked. Returns { error } or { values } (cleaned, safe to save).
 */
const validateTuitionBody = (body = {}, { partial = false } = {}) => {
  const values = {};
  const wants = (key) => !partial || body[key] !== undefined;

  if (wants("subject")) {
    const subject = cleanString(body.subject);
    if (subject.length < 2 || subject.length > 100)
      return { error: "Subject must be 2 to 100 characters" };
    values.subject = subject;
  }

  if (wants("classLevel")) {
    if (!CLASS_LEVELS.includes(body.classLevel))
      return { error: "Please select a valid class" };
    values.classLevel = body.classLevel;
  }

  if (wants("location")) {
    const location = cleanString(body.location);
    if (location.length < 2 || location.length > 150)
      return { error: "Location must be 2 to 150 characters" };
    values.location = location;
  }

  if (wants("budget")) {
    const budget = Number(body.budget);
    if (!Number.isFinite(budget) || budget <= 0 || budget > MAX_BUDGET)
      return { error: "Please enter a valid budget" };
    values.budget = Math.round(budget * 100) / 100;
  }

  if (wants("daysPerWeek")) {
    const days = Number(body.daysPerWeek);
    if (!Number.isInteger(days) || days < 1 || days > 7)
      return { error: "Days per week must be between 1 and 7" };
    values.daysPerWeek = days;
  }

  if (!partial || body.description !== undefined) {
    const description = cleanString(body.description);
    if (description.length > 2000)
      return { error: "Description must be 2000 characters or fewer" };
    values.description = description;
  }

  return { values };
};

const hasApprovedTutor = async (tuitionId) =>
  (await applications.countDocuments({ tuitionId, status: "Approved" }, { limit: 1 })) > 0;

/* ------------------------------ Public ------------------------------ */

/**
 * GET /api/tuitions?search&classLevel&subject&location&sort&page&limit
 * Approved tuitions only → { tuitions, total, page, limit, totalPages }
 */
export const listTuitions = asyncHandler(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 9, 50);
  const search = cleanString(req.query.search).slice(0, 100);
  const classLevel = cleanString(req.query.classLevel).slice(0, 50);
  const subject = cleanString(req.query.subject).slice(0, 100);
  const location = cleanString(req.query.location).slice(0, 150);
  const sort = SORTS[req.query.sort] || SORTS.date_desc;

  const filter = { status: "Approved" };

  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ subject: pattern }, { location: pattern }];
  }
  if (classLevel) filter.classLevel = classLevel;
  if (subject) filter.subject = { $regex: escapeRegex(subject), $options: "i" };
  if (location) filter.location = { $regex: escapeRegex(location), $options: "i" };

  const [total, items] = await Promise.all([
    tuitions.countDocuments(filter),
    tuitions
      .find(filter, { projection: PUBLIC_PROJECTION })
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
  ]);

  return res.json({
    tuitions: items,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

/** GET /api/tuitions/latest?limit=6 → newest approved tuitions. */
export const getLatestTuitions = asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 6, 12);

  const items = await tuitions
    .find({ status: "Approved" }, { projection: PUBLIC_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();

  return res.json(items);
});

/** GET /api/tuitions/filter-options → { subjects, locations } for the filter dropdowns. */
export const getFilterOptions = asyncHandler(async (req, res) => {
  const [subjects, locations] = await Promise.all([
    tuitions.distinct("subject", { status: "Approved" }),
    tuitions.distinct("location", { status: "Approved" }),
  ]);

  const tidy = (list) =>
    [...new Set(list.map((item) => String(item).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 200);

  return res.json({ subjects: tidy(subjects), locations: tidy(locations) });
});

/**
 * GET /api/tuitions/:id
 * Public for Approved tuitions. Pending/Rejected ones are visible only to
 * their owner or an admin (via the optional token); everyone else gets 404.
 */
export const getTuitionById = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid tuition id" });

  const tuition = await tuitions.findOne({ _id });
  if (!tuition) return res.status(404).json({ message: "Tuition not found" });

  let canSeePrivate = false;
  if (req.user) {
    if (tuition.studentEmail === req.user.email) {
      canSeePrivate = true;
    } else {
      const account = await users.findOne(
        { email: req.user.email },
        { projection: { role: 1 } }
      );
      canSeePrivate = account?.role === "admin";
    }
  }

  if (tuition.status !== "Approved" && !canSeePrivate) {
    return res.status(404).json({ message: "Tuition not found" });
  }

  if (!canSeePrivate) delete tuition.studentEmail;
  return res.json(tuition);
});

/* ------------------------------ Student ------------------------------ */

/** POST /api/tuitions: always created as "Pending" for admin review. */
export const createTuition = asyncHandler(async (req, res) => {
  const { error, values } = validateTuitionBody(req.body);
  if (error) return res.status(400).json({ message: error });

  const account = await users.findOne(
    { email: req.user.email },
    { projection: { name: 1 } }
  );

  const doc = {
    ...values,
    studentName: account?.name || "",
    studentEmail: req.user.email,
    status: "Pending", // never taken from the client
    createdAt: new Date(),
  };

  const result = await tuitions.insertOne(doc);
  return res.status(201).json({ ...doc, _id: result.insertedId });
});

/** GET /api/tuitions/my: the student's own posts (any status). */
export const getMyTuitions = asyncHandler(async (req, res) => {
  const items = await tuitions
    .find({ studentEmail: req.user.email })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  return res.json(items);
});

/**
 * PATCH /api/tuitions/:id: owner only. Someone else's tuition returns 404
 * (not 403) so the client never mistakes it for an expired session.
 */
export const updateTuition = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid tuition id" });

  const tuition = await tuitions.findOne({ _id, studentEmail: req.user.email });
  if (!tuition) return res.status(404).json({ message: "Tuition not found" });

  const { error, values } = validateTuitionBody(req.body, { partial: true });
  if (error) return res.status(400).json({ message: error });
  if (Object.keys(values).length === 0)
    return res.status(400).json({ message: "Nothing to update" });

  if (await hasApprovedTutor(_id)) {
    return res
      .status(409)
      .json({ message: "This tuition already has an approved tutor and can no longer be edited" });
  }

  const updated = await tuitions.findOneAndUpdate(
    { _id, studentEmail: req.user.email },
    { $set: { ...values, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  return res.json(updated);
});

/** DELETE /api/tuitions/:id: owner only; also removes the tuition's applications. */
export const deleteTuition = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid tuition id" });

  const tuition = await tuitions.findOne({ _id, studentEmail: req.user.email });
  if (!tuition) return res.status(404).json({ message: "Tuition not found" });

  if (await hasApprovedTutor(_id)) {
    return res
      .status(409)
      .json({ message: "This tuition already has an approved tutor and cannot be deleted" });
  }

  await tuitions.deleteOne({ _id, studentEmail: req.user.email });
  await applications.deleteMany({ tuitionId: _id });

  return res.json({ message: "Tuition deleted", deleted: true });
});
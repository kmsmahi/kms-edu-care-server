import { users, connectDB, toObjectId } from "../config/db.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9]{10,15}$/;
const URL_PATTERN = /^https?:\/\/\S+$/i;

// Roles a person may pick for themselves. "admin" can never be self-assigned.
const SELF_SERVICE_ROLES = ["student", "tutor"];

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();
const cleanString = (value) => (typeof value === "string" ? value.trim() : "");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isValidPhone = (value) => PHONE_PATTERN.test(value.replace(/[\s-]/g, ""));

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

const getUsersCollection = async () => {
  if (!users) await connectDB();
  return users;
};

/* ------------------------------ Users ------------------------------ */

/**
 * POST /api/users: create the profile on registration or Google login.
 *
 * INSERT-ONLY: if the email already exists, NOTHING is changed, so an
 * existing student/tutor/admin keeps their role (Google login can never
 * demote or promote anyone). New accounts get the requested role only if
 * it is "student" or "tutor"; otherwise "student".
 *
 * With FIREBASE_PROJECT_ID set, a valid access token for that same email
 * is required (prevents squatting on someone else's email).
 */
export const upsertUser = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const body = req.body || {};
  const email = normalizeEmail(body.email);

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ message: "A valid email is required" });
  }

  const requesterEmail = normalizeEmail(req.user?.email);
  if (requesterEmail && requesterEmail !== email) {
    return res
      .status(403)
      .json({ message: "You can only create your own profile" });
  }
  if (!requesterEmail && process.env.FIREBASE_PROJECT_ID) {
    return res
      .status(401)
      .json({ message: "Unauthorized: access token missing" });
  }

  const name = cleanString(body.name).slice(0, 100);
  const phone = cleanString(body.phone);
  const photoUrl = cleanString(body.photoUrl);

  if (phone && !isValidPhone(phone)) {
    return res
      .status(400)
      .json({ message: "Please provide a valid phone number" });
  }
  if (photoUrl && (!URL_PATTERN.test(photoUrl) || photoUrl.length > 500)) {
    return res
      .status(400)
      .json({ message: "Photo URL must be a valid http(s) link" });
  }

  const requestedRole = String(body.role ?? "").trim().toLowerCase();
  const role = SELF_SERVICE_ROLES.includes(requestedRole)
    ? requestedRole
    : "student";

  let created = false;
  try {
    const result = await usersCol.updateOne(
      { email },
      {
        $setOnInsert: {
          email,
          name,
          phone,
          photoUrl,
          role,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
    created = result.upsertedCount > 0;
  } catch (error) {
    // Two simultaneous requests raced on the unique email index: the account exists
    if (error.code !== 11000) throw error;
  }

  const account = await usersCol.findOne({ email });
  return res.status(created ? 201 : 200).json({ created, user: account });
});

/** GET /api/users/role/:email: { role }. Own email only (admins may look up anyone). */
export const getUserRole = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const email = normalizeEmail(req.params.email);
  const requesterEmail = normalizeEmail(req.user?.email);
  const isSelf = email === requesterEmail;

  const requester = await usersCol.findOne(
    { email: requesterEmail },
    { projection: { role: 1 } }
  );

  if (!isSelf && requester?.role !== "admin") {
    return res
      .status(403)
      .json({ message: "Forbidden: you can only view your own role" });
  }

  const account = isSelf
    ? requester
    : await usersCol.findOne({ email }, { projection: { role: 1 } });

  if (!account) return res.status(404).json({ message: "User not found" });

  return res.json({ role: account.role });
});

/** GET /api/users/me: the logged-in user's profile. */
export const getMyProfile = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const account = await usersCol.findOne({ email: normalizeEmail(req.user?.email) });
  if (!account) return res.status(404).json({ message: "User not found" });
  return res.json(account);
});

/** PATCH /api/users/profile: update name, phone and/or photoUrl. */
export const updateMyProfile = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const body = req.body || {};
  const updates = {};

  if (body.name !== undefined) {
    const name = cleanString(body.name);
    if (name.length < 2 || name.length > 100) {
      return res
        .status(400)
        .json({ message: "Name must be 2 to 100 characters" });
    }
    updates.name = name;
  }

  if (body.phone !== undefined) {
    const phone = cleanString(body.phone);
    if (phone && !isValidPhone(phone)) {
      return res
        .status(400)
        .json({ message: "Please provide a valid phone number" });
    }
    updates.phone = phone;
  }

  if (body.photoUrl !== undefined) {
    const photoUrl = cleanString(body.photoUrl);
    if (photoUrl && (!URL_PATTERN.test(photoUrl) || photoUrl.length > 500)) {
      return res
        .status(400)
        .json({ message: "Photo URL must be a valid http(s) link" });
    }
    updates.photoUrl = photoUrl;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  const updated = await usersCol.findOneAndUpdate(
    { email: normalizeEmail(req.user?.email) },
    { $set: { ...updates, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!updated) return res.status(404).json({ message: "User not found" });
  return res.json(updated);
});

/* ------------------------------ Tutors ------------------------------ */
// Public directory. Only safe fields are returned: no email, no phone.
// qualifications + experience come from the tutor's most recent application.

const withLatestApplication = [
  {
    $lookup: {
      from: "applications",
      let: { email: "$email" },
      pipeline: [
        { $match: { $expr: { $eq: ["$tutorEmail", "$$email"] } } },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, qualifications: 1, experience: 1 } },
      ],
      as: "latestApplication",
    },
  },
  {
    $addFields: {
      qualifications: {
        $ifNull: [{ $arrayElemAt: ["$latestApplication.qualifications", 0] }, ""],
      },
      experience: {
        $ifNull: [{ $arrayElemAt: ["$latestApplication.experience", 0] }, ""],
      },
    },
  },
  {
    $project: {
      name: 1,
      photoUrl: 1,
      createdAt: 1,
      qualifications: 1,
      experience: 1,
    },
  },
];

const buildTutorFilter = (search) => ({
  role: "tutor",
  ...(search && { name: { $regex: escapeRegex(search), $options: "i" } }),
});

/** GET /api/tutors?search&page&limit -> { tutors, total, page, limit, totalPages } */
export const listTutors = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 8, 50);
  const search = cleanString(req.query.search).slice(0, 100);
  const filter = buildTutorFilter(search);

  const [total, tutors] = await Promise.all([
    usersCol.countDocuments(filter),
    usersCol
      .aggregate([
        { $match: filter },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        ...withLatestApplication,
      ])
      .toArray(),
  ]);

  return res.json({
    tutors,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

/** GET /api/tutors/latest?limit=4 -> array of the newest tutors. */
export const getLatestTutors = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const limit = parsePositiveInt(req.query.limit, 4, 12);

  const tutors = await usersCol
    .aggregate([
      { $match: { role: "tutor" } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: limit },
      ...withLatestApplication,
    ])
    .toArray();

  return res.json(tutors);
});

/** GET /api/tutors/:id -> one tutor's public profile. */
export const getTutorById = asyncHandler(async (req, res) => {
  const usersCol = await getUsersCollection();
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid tutor id" });

  const [tutor] = await usersCol
    .aggregate([{ $match: { _id, role: "tutor" } }, ...withLatestApplication])
    .toArray();

  if (!tutor) return res.status(404).json({ message: "Tutor not found" });
  return res.json(tutor);
});
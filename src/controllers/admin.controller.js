import {
  applications,
  connectDB,
  payments,
  tuitions,
  users,
  toObjectId,
} from "../config/db.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const ROLES = ["student", "tutor", "admin"];
const NON_ADMIN_ROLES = ["student", "tutor"];
const TUITION_STATUSES = ["Pending", "Approved", "Rejected"];

const PHONE_PATTERN = /^\+?[0-9]{10,15}$/;
const URL_PATTERN = /^https?:\/\/\S+$/i;

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();
const cleanString = (value) => (typeof value === "string" ? value.trim() : "");
const isValidPhone = (value) => PHONE_PATTERN.test(value.replace(/[\s-]/g, ""));
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const getOwnerEmail = () => normalizeEmail(process.env.OWNER_EMAIL);
const isOwnerEmail = (email) => {
  const ownerEmail = getOwnerEmail();
  return Boolean(ownerEmail) && normalizeEmail(email) === ownerEmail;
};

/** Payments are recorded in the currency Stripe charged (PAYMENT_CURRENCY). */
const platformCurrency = () =>
  (process.env.PAYMENT_CURRENCY || "usd").trim().toUpperCase();

const getCollections = async () => {
  if (!users || !tuitions || !applications || !payments) {
    await connectDB();
  }
  return { users, tuitions, applications, payments };
};

/** Sums succeeded payments (in the platform currency) matching an extra filter. */
const sumPayments = async (paymentsCol, match = {}) => {
  const [row] = await paymentsCol
    .aggregate([
      { $match: { status: "succeeded", currency: platformCurrency(), ...match } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ])
    .toArray();
  return round2(row?.total);
};

/* ------------------------- Dashboard overview ------------------------- */

/**
 * GET /api/dashboard/stats: numbers for the logged-in user's Overview page.
 * The role is read from MongoDB by verifyRole, then the matching set is returned.
 */
export const getDashboardStats = asyncHandler(async (req, res) => {
  const {
    users: usersCol,
    tuitions: tuitionsCol,
    applications: applicationsCol,
    payments: paymentsCol,
  } = await getCollections();

  const email = normalizeEmail(req.user.email);
  const role = req.user.role;
  const currency = platformCurrency();

  if (role === "student") {
    const [totalTuitions, pendingTuitions, totalApplicants, totalPaid] =
      await Promise.all([
        tuitionsCol.countDocuments({ studentEmail: email }),
        tuitionsCol.countDocuments({ studentEmail: email, status: "Pending" }),
        applicationsCol.countDocuments({ studentEmail: email }),
        sumPayments(paymentsCol, { studentEmail: email }),
      ]);
    return res.json({
      role,
      currency,
      totalTuitions,
      pendingTuitions,
      totalApplicants,
      totalPaid,
    });
  }

  if (role === "tutor") {
    const [totalApplications, pendingApplications, ongoingTuitions, totalEarnings] =
      await Promise.all([
        applicationsCol.countDocuments({ tutorEmail: email }),
        applicationsCol.countDocuments({ tutorEmail: email, status: "Pending" }),
        applicationsCol.countDocuments({ tutorEmail: email, status: "Approved" }),
        sumPayments(paymentsCol, { tutorEmail: email }),
      ]);
    return res.json({
      role,
      currency,
      totalApplications,
      pendingApplications,
      ongoingTuitions,
      totalEarnings,
    });
  }

  // admin
  const [totalUsers, totalTuitions, pendingTuitions, totalEarnings] =
    await Promise.all([
      usersCol.countDocuments(),
      tuitionsCol.countDocuments(),
      tuitionsCol.countDocuments({ status: "Pending" }),
      sumPayments(paymentsCol),
    ]);
  return res.json({
    role,
    currency,
    totalUsers,
    totalTuitions,
    pendingTuitions,
    totalEarnings,
  });
});

/* ------------------------------- Users ------------------------------- */

/** GET /api/admin/users: all users. */
export const listUsers = asyncHandler(async (req, res) => {
  const { users: usersCol } = await getCollections();
  const items = await usersCol
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(2000)
    .toArray();
  return res.json(items);
});

/** GET /api/admin/owner-status: indicates if the caller is the configured owner. */
export const getOwnerStatus = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.user?.email);
  return res.json({
    isOwner: isOwnerEmail(email),
    ownerConfigured: Boolean(getOwnerEmail()),
  });
});

/** PATCH /api/admin/users/:id: edit name, phone and/or photoUrl. */
export const updateUser = asyncHandler(async (req, res) => {
  const { users: usersCol } = await getCollections();
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid user id" });

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
    { _id },
    { $set: { ...updates, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!updated) return res.status(404).json({ message: "User not found" });
  return res.json(updated);
});

/**
 * PATCH /api/admin/users/:id/role  { role }
 * - Only OWNER_EMAIL can assign or remove the "admin" role.
 * - Standard admins can switch users between "student" and "tutor".
 * - Business-rule blocks return 409 so the client does not log the admin out.
 */
export const changeUserRole = asyncHandler(async (req, res) => {
  const { users: usersCol } = await getCollections();
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid user id" });

  const role = String(req.body?.role ?? "").trim().toLowerCase();
  if (!ROLES.includes(role)) {
    return res
      .status(400)
      .json({ message: "Role must be student, tutor or admin" });
  }

  const target = await usersCol.findOne({ _id });
  if (!target) return res.status(404).json({ message: "User not found" });

  const requesterEmail = normalizeEmail(req.user?.email);
  const callerIsOwner = isOwnerEmail(requesterEmail);
  const targetIsOwner = isOwnerEmail(target.email);

  if (targetIsOwner && role !== "admin") {
    return res
      .status(409)
      .json({ message: "The system owner account cannot be demoted" });
  }

  // Only the owner can promote to admin or demote an existing admin
  if ((role === "admin" || target.role === "admin") && !callerIsOwner) {
    return res.status(409).json({
      message: "Only the system owner can grant or remove admin privileges",
    });
  }

  if (
    !callerIsOwner &&
    !NON_ADMIN_ROLES.includes(role)
  ) {
    return res.status(409).json({
      message: "Admins can only assign student or tutor roles",
    });
  }

  if (normalizeEmail(target.email) === requesterEmail && target.role === role) {
    return res.json(target);
  }

  if (normalizeEmail(target.email) === requesterEmail && !targetIsOwner) {
    return res
      .status(409)
      .json({ message: "You cannot change your own role" });
  }

  if (target.role === role) return res.json(target);

  if (target.role === "admin") {
    const adminCount = await usersCol.countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      return res
        .status(409)
        .json({ message: "The last remaining admin cannot be demoted" });
    }
  }

  const updated = await usersCol.findOneAndUpdate(
    { _id },
    { $set: { role, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return res.json(updated);
});

/**
 * DELETE /api/admin/users/:id
 * Removes the account plus its open content (pending tuitions and applications).
 * Anything tied to a payment (approved applications, their tuitions, payment records)
 * is kept so financial history stays intact.
 */
export const deleteUser = asyncHandler(async (req, res) => {
  const {
    users: usersCol,
    tuitions: tuitionsCol,
    applications: applicationsCol,
  } = await getCollections();

  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid user id" });

  const target = await usersCol.findOne({ _id });
  if (!target) return res.status(404).json({ message: "User not found" });

  if (isOwnerEmail(target.email)) {
    return res
      .status(409)
      .json({ message: "The system owner account cannot be deleted" });
  }

  if (normalizeEmail(target.email) === normalizeEmail(req.user?.email)) {
    return res
      .status(409)
      .json({ message: "You cannot delete your own account" });
  }

  if (target.role === "admin") {
    const adminCount = await usersCol.countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      return res
        .status(409)
        .json({ message: "The last remaining admin cannot be deleted" });
    }
  }

  const keepTuitionIds = await applicationsCol.distinct("tuitionId", {
    studentEmail: target.email,
    status: "Approved",
  });

  await tuitionsCol.deleteMany({
    studentEmail: target.email,
    _id: { $nin: keepTuitionIds },
  });
  await applicationsCol.deleteMany({
    $or: [
      { studentEmail: target.email, status: { $ne: "Approved" } },
      { tutorEmail: target.email, status: { $ne: "Approved" } },
    ],
  });
  await usersCol.deleteOne({ _id });

  return res.json({ message: "User deleted", deleted: true });
});

/* ------------------------------ Tuitions ------------------------------ */

/** GET /api/admin/tuitions: every post, any status (includes the student's email). */
export const listAllTuitions = asyncHandler(async (req, res) => {
  const { tuitions: tuitionsCol } = await getCollections();
  const items = await tuitionsCol
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(2000)
    .toArray();
  return res.json(items);
});

/** PATCH /api/admin/tuitions/:id/status  { status: "Approved" | "Rejected" } */
export const updateTuitionStatus = asyncHandler(async (req, res) => {
  const { tuitions: tuitionsCol, applications: applicationsCol } =
    await getCollections();

  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid tuition id" });

  const status = req.body?.status;
  if (!["Approved", "Rejected"].includes(status)) {
    return res
      .status(400)
      .json({ message: 'Status must be "Approved" or "Rejected"' });
  }

  const tuition = await tuitionsCol.findOne({ _id });
  if (!tuition) return res.status(404).json({ message: "Tuition not found" });

  if (tuition.status === status) return res.json(tuition);

  if (status === "Rejected") {
    const hasApprovedTutor =
      (await applicationsCol.countDocuments(
        { tuitionId: _id, status: "Approved" },
        { limit: 1 }
      )) > 0;
    if (hasApprovedTutor) {
      return res.status(409).json({
        message:
          "This tuition already has an approved, paid tutor and cannot be rejected",
      });
    }
  }

  const updated = await tuitionsCol.findOneAndUpdate(
    { _id },
    {
      $set: {
        status,
        reviewedAt: new Date(),
        reviewedBy: normalizeEmail(req.user.email),
      },
    },
    { returnDocument: "after" }
  );
  return res.json(updated);
});

/* ------------------------------ Reports ------------------------------ */

const monthLabel = (year, month) =>
  new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * GET /api/admin/reports
 * -> { totalEarnings, currency, totalUsers, totalTuitions, transactions,
 *      monthlyEarnings, userRoles, tuitionStatuses }
 */
export const getReports = asyncHandler(async (req, res) => {
  const {
    users: usersCol,
    tuitions: tuitionsCol,
    payments: paymentsCol,
  } = await getCollections();

  const currency = platformCurrency();

  const [
    totalEarnings,
    totalUsers,
    totalTuitions,
    transactions,
    monthlyRows,
    roleRows,
    statusRows,
  ] = await Promise.all([
    sumPayments(paymentsCol),
    usersCol.countDocuments(),
    tuitionsCol.countDocuments(),
    paymentsCol
      .find({ status: "succeeded" }, { projection: { paymentIntentId: 0 } })
      .sort({ paidAt: -1, _id: -1 })
      .limit(500)
      .toArray(),
    paymentsCol
      .aggregate([
        {
          $match: {
            status: "succeeded",
            currency,
            paidAt: { $type: "date" },
          },
        },
        {
          $group: {
            _id: { y: { $year: "$paidAt" }, m: { $month: "$paidAt" } },
            total: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.y": -1, "_id.m": -1 } },
        { $limit: 12 },
      ])
      .toArray(),
    usersCol.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]).toArray(),
    tuitionsCol
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray(),
  ]);

  const monthlyEarnings = monthlyRows
    .reverse() // oldest -> newest for the chart
    .map((row) => ({
      month: monthLabel(row._id.y, row._id.m),
      total: round2(row.total),
    }));

  const countFor = (rows, key) => rows.find((row) => row._id === key)?.count || 0;

  const userRoles = ROLES.map((role) => ({
    role,
    count: countFor(roleRows, role),
  })).filter((item) => item.count > 0);

  const tuitionStatuses = TUITION_STATUSES.map((status) => ({
    status,
    count: countFor(statusRows, status),
  }));

  return res.json({
    totalEarnings,
    currency,
    totalUsers,
    totalTuitions,
    transactions,
    monthlyEarnings,
    userRoles,
    tuitionStatuses,
  });
});
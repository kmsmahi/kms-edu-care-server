import { applications, tuitions, users, toObjectId } from "../config/db.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const MAX_SALARY = 10_000_000;

const cleanString = (value) => (typeof value === "string" ? value.trim() : "");

/** Validates application fields. With { partial: true } only sent fields are checked. */
const validateApplicationBody = (body = {}, { partial = false } = {}) => {
  const values = {};
  const wants = (key) => !partial || body[key] !== undefined;

  if (wants("qualifications")) {
    const qualifications = cleanString(body.qualifications);
    if (qualifications.length < 2 || qualifications.length > 500)
      return { error: "Qualifications must be 2 to 500 characters" };
    values.qualifications = qualifications;
  }

  if (wants("experience")) {
    const experience = cleanString(body.experience);
    if (experience.length < 2 || experience.length > 1500)
      return { error: "Experience must be 2 to 1500 characters" };
    values.experience = experience;
  }

  if (wants("expectedSalary")) {
    const salary = Number(body.expectedSalary);
    if (!Number.isFinite(salary) || salary <= 0 || salary > MAX_SALARY)
      return { error: "Please enter a valid expected salary" };
    values.expectedSalary = Math.round(salary * 100) / 100;
  }

  return { values };
};

/**
 * Aggregation stages that attach a trimmed `tuition` object to each application,
 * containing ONLY the listed fields (never the student's email unless requested).
 */
const joinTuition = (fields) => [
  {
    $lookup: {
      from: "tuitions",
      localField: "tuitionId",
      foreignField: "_id",
      as: "tuitionDoc",
    },
  },
  { $unwind: { path: "$tuitionDoc", preserveNullAndEmptyArrays: true } },
  {
    $addFields: {
      tuition: Object.fromEntries(fields.map((f) => [f, `$tuitionDoc.${f}`])),
    },
  },
  { $project: { tuitionDoc: 0 } },
];

const BASIC_TUITION_FIELDS = ["subject", "classLevel", "location"];

/* ------------------------------ Tutor ------------------------------ */

/**
 * POST /api/applications: a tutor applies to an Approved tuition.
 * Identity (name, photo, email) comes from the account, never from the request body.
 */
export const applyToTuition = asyncHandler(async (req, res) => {
  const tuitionId = toObjectId(req.body?.tuitionId);
  if (!tuitionId) return res.status(400).json({ message: "Invalid tuition id" });

  const { error, values } = validateApplicationBody(req.body);
  if (error) return res.status(400).json({ message: error });

  const tuition = await tuitions.findOne({ _id: tuitionId, status: "Approved" });
  if (!tuition) {
    return res
      .status(404)
      .json({ message: "This tuition was not found or is not open for applications" });
  }

  if (tuition.studentEmail === req.user.email) {
    return res.status(400).json({ message: "You cannot apply to your own tuition" });
  }

  const alreadyFilled =
    (await applications.countDocuments({ tuitionId, status: "Approved" }, { limit: 1 })) > 0;
  if (alreadyFilled) {
    return res
      .status(409)
      .json({ message: "A tutor has already been approved for this tuition" });
  }

  const account = await users.findOne(
    { email: req.user.email },
    { projection: { name: 1, photoUrl: 1 } }
  );

  const doc = {
    tuitionId,
    studentEmail: tuition.studentEmail,
    tutorEmail: req.user.email,
    tutorName: account?.name || req.user.email.split("@")[0],
    tutorPhoto: account?.photoUrl || "",
    ...values,
    status: "Pending", // never taken from the client
    createdAt: new Date(),
  };

  try {
    const result = await applications.insertOne(doc);
    return res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (insertError) {
    if (insertError.code === 11000) {
      return res.status(409).json({ message: "You have already applied to this tuition" });
    }
    throw insertError;
  }
});

/** GET /api/applications/tutor: the tutor's own applications. */
export const listTutorApplications = asyncHandler(async (req, res) => {
  const items = await applications
    .aggregate([
      { $match: { tutorEmail: req.user.email } },
      { $sort: { createdAt: -1, _id: -1 } },
      ...joinTuition(BASIC_TUITION_FIELDS),
      { $project: { studentEmail: 0, pendingPaymentIntentId: 0 } },
    ])
    .toArray();

  return res.json(items);
});

/**
 * GET /api/tutor/ongoing-tuitions: applications that were Approved (paid).
 * Only now does the tutor get the student's contact email.
 */
export const listOngoingTuitions = asyncHandler(async (req, res) => {
  const items = await applications
    .aggregate([
      { $match: { tutorEmail: req.user.email, status: "Approved" } },
      { $sort: { approvedAt: -1, createdAt: -1 } },
      ...joinTuition([
        "subject",
        "classLevel",
        "location",
        "daysPerWeek",
        "studentName",
        "studentEmail",
      ]),
      { $project: { studentEmail: 0, pendingPaymentIntentId: 0, paymentIntentId: 0 } },
    ])
    .toArray();

  return res.json(items);
});

/** PATCH /api/applications/:id: tutor edits their own application while "Pending". */
export const updateApplication = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid application id" });

  const existing = await applications.findOne({ _id, tutorEmail: req.user.email });
  if (!existing) return res.status(404).json({ message: "Application not found" });

  if (existing.status !== "Pending") {
    return res.status(409).json({ message: "Only pending applications can be edited" });
  }

  const { error, values } = validateApplicationBody(req.body, { partial: true });
  if (error) return res.status(400).json({ message: error });
  if (Object.keys(values).length === 0)
    return res.status(400).json({ message: "Nothing to update" });

  // The status is part of the filter, so a concurrent approval can't be overwritten
  const updated = await applications.findOneAndUpdate(
    { _id, tutorEmail: req.user.email, status: "Pending" },
    { $set: { ...values, updatedAt: new Date() } },
    { returnDocument: "after", projection: { studentEmail: 0, pendingPaymentIntentId: 0 } }
  );

  if (!updated) {
    return res.status(409).json({ message: "Only pending applications can be edited" });
  }
  return res.json(updated);
});

/** DELETE /api/applications/:id: tutor deletes their own application while "Pending". */
export const deleteApplication = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid application id" });

  const existing = await applications.findOne({ _id, tutorEmail: req.user.email });
  if (!existing) return res.status(404).json({ message: "Application not found" });

  const result = await applications.deleteOne({
    _id,
    tutorEmail: req.user.email,
    status: "Pending",
  });

  if (result.deletedCount === 0) {
    return res.status(409).json({ message: "Only pending applications can be deleted" });
  }
  return res.json({ message: "Application deleted", deleted: true });
});

/* ------------------------------ Student ------------------------------ */

/** GET /api/applications/student: applicants for the student's tuitions. */
export const listStudentApplications = asyncHandler(async (req, res) => {
  const items = await applications
    .aggregate([
      { $match: { studentEmail: req.user.email } },
      { $sort: { createdAt: -1, _id: -1 } },
      ...joinTuition(BASIC_TUITION_FIELDS),
      // The student sees name, photo, qualifications, experience and salary, not emails
      {
        $project: {
          studentEmail: 0,
          tutorEmail: 0,
          pendingPaymentIntentId: 0,
          paymentIntentId: 0,
        },
      },
    ])
    .toArray();

  return res.json(items);
});

/** PATCH /api/applications/:id/reject: the tuition's owner rejects a Pending applicant. */
export const rejectApplication = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid application id" });

  const updated = await applications.findOneAndUpdate(
    { _id, studentEmail: req.user.email, status: "Pending" },
    { $set: { status: "Rejected", rejectedAt: new Date() } },
    { returnDocument: "after", projection: { studentEmail: 0, tutorEmail: 0 } }
  );

  if (updated) return res.json(updated);

  const exists = await applications.findOne(
    { _id, studentEmail: req.user.email },
    { projection: { status: 1 } }
  );
  if (!exists) return res.status(404).json({ message: "Application not found" });

  return res
    .status(409)
    .json({ message: `This application is already ${exists.status.toLowerCase()}` });
});

/* ------------------------------ Shared ------------------------------ */

/**
 * GET /api/applications/:id: a single application, visible only to the student
 * who owns the tuition or the tutor who applied (used by the checkout page).
 */
export const getApplicationById = asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid application id" });

  const [application] = await applications
    .aggregate([
      {
        $match: {
          _id,
          $or: [{ studentEmail: req.user.email }, { tutorEmail: req.user.email }],
        },
      },
      ...joinTuition(BASIC_TUITION_FIELDS),
      {
        $project: {
          studentEmail: 0,
          tutorEmail: 0,
          pendingPaymentIntentId: 0,
          paymentIntentId: 0,
        },
      },
    ])
    .toArray();

  if (!application) return res.status(404).json({ message: "Application not found" });
  return res.json(application);
});
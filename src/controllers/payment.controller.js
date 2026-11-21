import { applications, payments, tuitions, toObjectId } from "../config/db.js";
import { getStripe } from "../config/stripe.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

/* ------------------------------ Helpers ------------------------------ */

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Currencies Stripe treats as having no minor unit (amount is sent as-is)
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]+$/;

/** Runs a Stripe call and converts Stripe errors into safe HTTP errors (never 401/403). */
const stripeCall = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (typeof error?.type === "string" && error.type.startsWith("Stripe")) {
      console.error("Stripe error:", error.type, error.message);
      if (error.type === "StripeCardError") throw httpError(402, error.message);
      throw httpError(502, "Payment provider error. Please try again.");
    }
    throw error;
  }
};

/**
 * Salaries are stored in BDT. Stripe charges in PAYMENT_CURRENCY, converted
 * with PAYMENT_EXCHANGE_RATE (BDT per 1 unit). Refuses to charge if the
 * conversion is not configured, so nobody is ever charged the wrong amount.
 */
const getChargeDetails = (salaryInBdt) => {
  const currency = (process.env.PAYMENT_CURRENCY || "usd").toLowerCase();
  let rate = 1;

  if (currency !== "bdt") {
    rate = Number(process.env.PAYMENT_EXCHANGE_RATE);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw httpError(
        500,
        "Payment currency conversion is not configured (set PAYMENT_EXCHANGE_RATE)"
      );
    }
  }

  const multiplier = ZERO_DECIMAL.has(currency) ? 1 : 100;
  const amountMinor = Math.round((Number(salaryInBdt) / rate) * multiplier);

  if (!Number.isFinite(amountMinor) || amountMinor < (multiplier === 1 ? 1 : 50)) {
    throw httpError(400, "This amount is too small to be charged online");
  }

  return { currency, amountMinor, amountMajor: amountMinor / multiplier };
};

/** Payment fields that are safe to send back to the browser. */
const publicPayment = (payment) => ({
  _id: payment._id,
  transactionId: payment.transactionId,
  amount: payment.amount,
  currency: payment.currency,
  tuitionSubject: payment.tuitionSubject,
  tutorName: payment.tutorName,
  paidAt: payment.paidAt,
});

const conflictAfterPayment = (paymentIntentId, status) =>
  httpError(
    409,
    `Your payment (reference ${paymentIntentId}) was received, but this application can no longer be approved (${String(
      status
    ).toLowerCase()}). Please contact support with that reference.`
  );

/* ------------------------------ Student ------------------------------ */

/**
 * POST /api/payments/create-intent  { applicationId }
 * The amount is calculated here from the stored application, never from the client.
 * Returns { clientSecret, amount, currency } (amount in major units, for display).
 */
export const createPaymentIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();

  const applicationId = toObjectId(req.body?.applicationId);
  if (!applicationId) return res.status(400).json({ message: "Invalid application id" });

  const application = await applications.findOne({
    _id: applicationId,
    studentEmail: req.user.email,
  });
  if (!application) return res.status(404).json({ message: "Application not found" });

  if (application.status !== "Pending") {
    return res
      .status(409)
      .json({ message: `This application is already ${application.status.toLowerCase()}` });
  }

  const alreadyFilled =
    (await applications.countDocuments(
      { tuitionId: application.tuitionId, status: "Approved" },
      { limit: 1 }
    )) > 0;
  if (alreadyFilled) {
    return res
      .status(409)
      .json({ message: "A tutor has already been approved for this tuition" });
  }

  const tuition = await tuitions.findOne(
    { _id: application.tuitionId },
    { projection: { subject: 1 } }
  );
  if (!tuition) return res.status(404).json({ message: "Tuition not found" });

  const { currency, amountMinor, amountMajor } = getChargeDetails(application.expectedSalary);

  // Reuse the open PaymentIntent (e.g. page refresh) instead of piling up new ones
  let intent = null;
  if (application.pendingPaymentIntentId) {
    try {
      const existing = await stripeCall(() =>
        stripe.paymentIntents.retrieve(application.pendingPaymentIntentId)
      );
      const reusable =
        ["requires_payment_method", "requires_confirmation", "requires_action"].includes(
          existing.status
        ) &&
        existing.amount === amountMinor &&
        existing.currency === currency;
      if (reusable) intent = existing;
    } catch {
      intent = null; // fall through and create a fresh one
    }
  }

  if (!intent) {
    intent = await stripeCall(() =>
      stripe.paymentIntents.create({
        amount: amountMinor,
        currency,
        // Cards/wallets only: the client confirms with redirect: "if_required"
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        description: `KMS EduCare tuition: ${tuition.subject}`,
        metadata: {
          applicationId: String(application._id),
          tuitionId: String(application.tuitionId),
          studentEmail: req.user.email,
          tutorEmail: application.tutorEmail,
          expectedSalary: String(application.expectedSalary),
        },
      })
    );

    await applications.updateOne(
      { _id: application._id },
      { $set: { pendingPaymentIntentId: intent.id } }
    );
  }

  return res.json({
    clientSecret: intent.client_secret,
    amount: amountMajor,
    currency: currency.toUpperCase(),
  });
});

/**
 * POST /api/payments/confirm  { applicationId, paymentIntentId }
 *
 * Approves the tutor ONLY after Stripe itself confirms the payment succeeded.
 * Safe to call again (idempotent): the PaymentIntent id is unique in `payments`.
 */
export const confirmPayment = asyncHandler(async (req, res) => {
  const stripe = getStripe();

  const applicationId = toObjectId(req.body?.applicationId);
  if (!applicationId) return res.status(400).json({ message: "Invalid application id" });

  const paymentIntentId = req.body?.paymentIntentId;
  if (typeof paymentIntentId !== "string" || !PAYMENT_INTENT_ID.test(paymentIntentId)) {
    return res.status(400).json({ message: "Invalid payment reference" });
  }

  const application = await applications.findOne({
    _id: applicationId,
    studentEmail: req.user.email,
  });
  if (!application) return res.status(404).json({ message: "Application not found" });

  // Already processed? Return the saved payment instead of doing it twice
  const recorded = await payments.findOne({ paymentIntentId });
  if (recorded) {
    if (
      String(recorded.applicationId) === String(applicationId) &&
      recorded.studentEmail === req.user.email
    ) {
      return res.json({
        message: "Payment already recorded",
        alreadyProcessed: true,
        payment: publicPayment(recorded),
      });
    }
    return res.status(409).json({ message: "This payment has already been used" });
  }

  // 1) Ask Stripe, never trust the browser
  const intent = await stripeCall(() => stripe.paymentIntents.retrieve(paymentIntentId));

  if (intent.status !== "succeeded") {
    return res.status(409).json({ message: "The payment has not been completed yet" });
  }

  if (
    intent.metadata?.applicationId !== String(application._id) ||
    intent.metadata?.studentEmail !== req.user.email
  ) {
    return res
      .status(400)
      .json({ message: "This payment does not belong to this application" });
  }

  // 2) Approve the tutor (only a Pending application, or one this same payment already approved)
  const now = new Date();
  if (application.status === "Pending") {
    let approved;
    try {
      approved = await applications.findOneAndUpdate(
        { _id: application._id, status: "Pending" },
        {
          $set: { status: "Approved", approvedAt: now, paymentIntentId },
          $unset: { pendingPaymentIntentId: "" },
        },
        { returnDocument: "after" }
      );
    } catch (error) {
      // Unique index: another tutor was approved for this tuition at the same moment
      if (error.code === 11000) throw conflictAfterPayment(paymentIntentId, "filled");
      throw error;
    }
    if (!approved) throw conflictAfterPayment(paymentIntentId, "changed");
  } else if (
    !(application.status === "Approved" && application.paymentIntentId === paymentIntentId)
  ) {
    throw conflictAfterPayment(paymentIntentId, application.status);
  }

  // 3) Record the payment
  const tuition = await tuitions.findOne(
    { _id: application.tuitionId },
    { projection: { subject: 1, studentName: 1 } }
  );

  const currency = String(intent.currency).toLowerCase();
  const multiplier = ZERO_DECIMAL.has(currency) ? 1 : 100;
  const paidMinor = intent.amount_received || intent.amount;

  const paymentDoc = {
    paymentIntentId,
    transactionId: paymentIntentId,
    applicationId: application._id,
    tuitionId: application.tuitionId,
    tuitionSubject: tuition?.subject || "",
    studentEmail: req.user.email,
    studentName: tuition?.studentName || "",
    tutorEmail: application.tutorEmail,
    tutorName: application.tutorName,
    amount: paidMinor / multiplier,
    currency: currency.toUpperCase(),
    expectedSalary: Number(intent.metadata?.expectedSalary) || application.expectedSalary,
    status: "succeeded",
    paidAt: now,
    createdAt: now,
  };

  let saved = paymentDoc;
  try {
    const result = await payments.insertOne(paymentDoc);
    saved = { ...paymentDoc, _id: result.insertedId };
  } catch (error) {
    if (error.code !== 11000) throw error;
    saved = (await payments.findOne({ paymentIntentId })) || paymentDoc; // concurrent confirm
  }

  // 4) Competing applicants for the same tuition are rejected
  await applications.updateMany(
    { tuitionId: application.tuitionId, _id: { $ne: application._id }, status: "Pending" },
    {
      $set: {
        status: "Rejected",
        rejectedAt: now,
        rejectionReason: "Another tutor was selected",
      },
    }
  );

  return res.json({
    message: "Payment confirmed. The tutor has been approved.",
    payment: publicPayment(saved),
  });
});

/** GET /api/payments/student: the student's payment history. */
export const getStudentPayments = asyncHandler(async (req, res) => {
  const items = await payments
    .find(
      { studentEmail: req.user.email },
      { projection: { studentEmail: 0, tutorEmail: 0, paymentIntentId: 0 } }
    )
    .sort({ paidAt: -1, _id: -1 })
    .toArray();

  return res.json(items);
});

/* ------------------------------ Tutor ------------------------------ */

/** GET /api/payments/tutor: the tutor's revenue history. */
export const getTutorPayments = asyncHandler(async (req, res) => {
  const items = await payments
    .find(
      { tutorEmail: req.user.email },
      { projection: { studentEmail: 0, tutorEmail: 0, paymentIntentId: 0 } }
    )
    .sort({ paidAt: -1, _id: -1 })
    .toArray();

  return res.json(items);
});
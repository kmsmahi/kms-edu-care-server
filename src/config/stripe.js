import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) {
  console.warn(
    "⚠️  STRIPE_SECRET_KEY is not set. Payment routes will respond with an error until it is configured."
  );
}

/** Stripe SDK instance, or null when the secret key is missing. */
export const stripe = secretKey
  ? new Stripe(secretKey, {
      appInfo: { name: "KMS EduCare Server", version: "1.0.0" },
    })
  : null;

/** Returns the Stripe instance or throws a clear 500 error if it is not configured. */
export const getStripe = () => {
  if (!stripe) {
    const error = new Error("Stripe is not configured on the server");
    error.status = 500;
    throw error;
  }
  return stripe;
};

export default stripe;
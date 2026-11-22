# ⚙️ KMS EduCare — Server

Backend REST API for **KMS EduCare**, built with **Node.js**, **Express**, **MongoDB**, **JWT**, **Firebase Admin / Token Verification**, and **Stripe**.

- **Live Server URL:** [https://kms-edu-care-server.vercel.app/](https://kms-edu-care-server.vercel.app/)
- **Live API Base URL:** `https://kms-edu-care-server.vercel.app/api`
- **Live Client URL:** [https://kms-edu-care.web.app/](https://kms-edu-care.web.app/)

---

## 📌 Overview

The backend handles authentication session issuance, role-based access control, tuition moderation, tutor applications, administrative oversight, and Stripe payment verification and settlement across three active UI roles (`student`, `tutor`, `admin`) plus a protected super-admin `owner` account (`salauddinmahi2002@gmail.com`).

---

## 📁 Project Structure

```text
kms-educare-server/
├── config/
│   ├── db.js
│   └── stripe.js
├── controllers/
│   └── payment.controller.js
├── middlewares/
│   └── errorHandler.js
├── routes/
│   ├── auth.routes.js
│   ├── user.routes.js
│   ├── tuition.routes.js
│   ├── application.routes.js
│   ├── payment.routes.js
│   └── admin.routes.js
├── app.js
├── server.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
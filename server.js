require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const {
  SKYSLOPE_BASE_URL,
  SKYSLOPE_CLIENT_ID,
  SKYSLOPE_CLIENT_SECRET,
  SKYSLOPE_ACCESS_KEY,
  SKYSLOPE_ACCESS_SECRET,
  WEBHOOK_SHARED_SECRET,
  DEFAULT_EMAIL_DOMAIN = "agentcollective.com",
  DEFAULT_PHONE_AREA_CODE = "480"
} = process.env;

let sessionCache = {
  token: null,
  expiresAt: 0
};

function cleanString(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function normalizeName(firstName, lastName, fullName) {
  const first = cleanString(firstName);
  const last = cleanString(lastName);
  const full = cleanString(fullName);

  if (first && last) {
    return { firstName: first, lastName: last, fullName: `${first} ${last}`.trim() };
  }

  if (full) {
    const parts = full.replace(/\s+/g, " ").split(" ").filter(Boolean);
    let firstName = parts[0] || "Unknown";
    const lastName = parts.slice(1).join(" ") || "Client";

    if (firstName.toLowerCase() === "jeff") {
      firstName = "Geoff";
    }

    return {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim()
    };
  }

  return {
    firstName: "Unknown",
    lastName: "Client",
    fullName: "Unknown Client"
  };
}

function normalizeEmail(rawEmail, fullName) {
  const cleaned = cleanString(rawEmail).toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (emailRegex.test(cleaned)) {
    return cleaned;
  }

  const fallbackSlug = slugify(fullName) || "unknown.client";
  return `${fallbackSlug}.${Date.now()}@${DEFAULT_EMAIL_DOMAIN}`;
}

function normalizePhone(rawPhone) {
  let digits = String(rawPhone || "").replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length === 7) {
    digits = `${DEFAULT_PHONE_AREA_CODE}${digits}`;
  }

  if (digits.length > 10) {
    digits = digits.slice(0, 10);
  }

  if (digits.length < 10) {
    digits = (`${DEFAULT_PHONE_AREA_CODE}${digits}`).padEnd(10, "0").slice(0, 10);
  }

  return digits;
}

function normalizeAttachments(input) {
  let attachments = input;

  if (typeof attachments === "string") {
    attachments = JSON.parse(attachments);
  }

  if (!Array.isArray(attachments)) {
    throw new Error("Attachments payload must be an array or JSON string.");
  }

  const normalized = attachments
    .filter(Boolean)
    .map((a, idx) => {
      const url = cleanString(a.url);
      let fileName = cleanString(a.fileName || `attachment_${idx + 1}.pdf`);
      const mimeType = cleanString(a.mimeType || "application/pdf");

      if (!url) return null;

      if (!fileName.toLowerCase().endsWith(".pdf")) {
        fileName += ".pdf";
      }

      fileName = fileName.replace(/[^\w.\- ()]/g, " ").replace(/\s+/g, " ").trim();

      if (fileName.length > 150) {
        fileName = fileName.slice(0, 146).trim() + ".pdf";
      }

      return { url, fileName, mimeType };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error("No valid attachments after normalization.");
  }

  return normalized;
}

function buildSkySlopeAuthHeader() {
  const timestamp = new Date().toISOString();
  const input = `${SKYSLOPE_CLIENT_ID}:${SKYSLOPE_CLIENT_SECRET}:${timestamp}`;
  const hmac = crypto
    .createHmac("sha256", SKYSLOPE_ACCESS_SECRET)
    .update(input)
    .digest("base64");

  return {
    timestamp,
    authorization: `SS ${SKYSLOPE_ACCESS_KEY}:${hmac}`
  };
}

async function getSkySlopeSession() {
  const now = Date.now();

  if (sessionCache.token && now < sessionCache.expiresAt - 60000) {
    return sessionCache.token;
  }

  const auth = buildSkySlopeAuthHeader();

  const response = await axios.post(
    `${SKYSLOPE_BASE_URL}/auth/login`,
    {
      clientID: SKYSLOPE_CLIENT_ID,
      clientSecret: SKYSLOPE_CLIENT_SECRET
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Timestamp": auth.timestamp,
        "Authorization": auth.authorization
      }
    }
  );

  const session = response.data?.Session || response.data?.session;
  const expiration = response.data?.Expiration || response.data?.expiration;

  if (!session) {
    throw new Error(`SkySlope login failed. Unexpected response: ${JSON.stringify(response.data)}`);
  }

  sessionCache.token = session;
  sessionCache.expiresAt = expiration ? new Date(expiration).getTime() : Date.now() + 110 * 60 * 1000;

  return sessionCache.token;
}

async function skySlopeRequest(method, path, data = null) {
  const session = await getSkySlopeSession();

  const response = await axios({
    method,
    url: `${SKYSLOPE_BASE_URL}${path}`,
    data,
    headers: {
      "Content-Type": "application/json",
      "Session": session
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return response.data;
}

async function downloadFileAsBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data).toString("base64");
}

async function uploadDocumentToSale(saleGuid, attachment) {
  const base64Content = await downloadFileAsBase64(attachment.url);

  const payload = {
    fileName: attachment.fileName,
    base64Content
  };

  return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/documents`, payload);
}

async function createPlaceholderSale() {
  const payload = {
    officeGuid: "GILBERT_PLACEHOLDER",
    propertyType: "Residential",
    subType: "Other",
    transactionType: "Purchase",
    stage: "PreContract",
    saleType: "PassThrough"
  };

  const sale = await skySlopeRequest("post", "/api/files/sales", payload);

  const saleGuid =
    sale?.guid ||
    sale?.saleGuid ||
    sale?.id ||
    sale?.data?.guid;

  if (!saleGuid) {
    throw new Error(`Could not determine saleGuid from response: ${JSON.stringify(sale)}`);
  }

  return saleGuid;
}

async function addBuyerToSale(saleGuid, buyer) {
  const payload = {
    firstName: buyer.firstName,
    lastName: buyer.lastName,
    email: buyer.email,
    phoneNumber: buyer.phone
  };

  try {
    return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/buyerContact`, payload);
  } catch (err) {
    console.warn("Buyer add failed, continuing:", err.response?.data || err.message);
    return null;
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "SkySlope middleware running" });
});

app.post("/api/skyslope-upload", async (req, res) => {
  try {
    const sharedSecret = req.headers["x-shared-secret"];

    if (sharedSecret !== WEBHOOK_SHARED_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const clientName = normalizeName(
      req.body.clientFirstName,
      req.body.clientLastName,
      req.body.clientFullName
    );

    const buyer = {
      firstName: clientName.firstName,
      lastName: clientName.lastName,
      fullName: clientName.fullName,
      email: normalizeEmail(req.body.clientEmail, clientName.fullName),
      phone: normalizePhone(req.body.clientPhone)
    };

    const agent = {
      fullName: cleanString(req.body.agentFullName),
      email: cleanString(req.body.agentEmail)
    };

    const attachments = normalizeAttachments(req.body.attachments);

    const saleGuid = await createPlaceholderSale();

    await addBuyerToSale(saleGuid, buyer);

    const uploaded = [];
    for (const attachment of attachments) {
      const result = await uploadDocumentToSale(saleGuid, attachment);
      uploaded.push({
        fileName: attachment.fileName,
        uploaded: true,
        result
      });
    }

    const summaryText =
      `SkySlope upload successful. ` +
      `Client: ${buyer.fullName}. ` +
      `Client email used: ${buyer.email}. ` +
      `Client phone used: ${buyer.phone}. ` +
      `Agent: ${agent.fullName || "Unknown Agent"} <${agent.email || "unknown"}>. ` +
      `Attachments uploaded: ${uploaded.length}.`;

    return res.json({
      ok: true,
      saleGuid,
      clientFullName: buyer.fullName,
      clientEmail: buyer.email,
      clientPhone: buyer.phone,
      agentFullName: agent.fullName,
      agentEmail: agent.email,
      uploadedCount: uploaded.length,
      uploaded,
      summaryText
    });
  } catch (error) {
    console.error("SkySlope upload failure:", error.response?.data || error.message);

    return res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

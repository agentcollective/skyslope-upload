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
  DEFAULT_PHONE_AREA_CODE = "480",
  DEBUG_SKYSLOPE = "true",

  DEFAULT_TC_FIRST_NAME = "Amy",
  DEFAULT_TC_LAST_NAME = "Zabel",
  DEFAULT_TC_EMAIL = "TransactionSupport@agentcollective.com",
  DEFAULT_TC_PHONE = "6232290968",
  DEFAULT_TC_COMPANY = "",

  DEFAULT_CHECKLIST_TYPE_ID = "112821"
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
    return {
      firstName: first,
      lastName: last,
      fullName: `${first} ${last}`.trim()
    };
  }

  if (full) {
    const parts = full.replace(/\s+/g, " ").split(" ").filter(Boolean);
    let resolvedFirst = parts[0] || "Unknown";
    const resolvedLast = parts.slice(1).join(" ") || "Client";

    if (resolvedFirst.toLowerCase() === "jeff") {
      resolvedFirst = "Geoff";
    }

    return {
      firstName: resolvedFirst,
      lastName: resolvedLast,
      fullName: `${resolvedFirst} ${resolvedLast}`.trim()
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

function summarizeAxiosError(error) {
  return {
    message: error.message,
    status: error.response?.status || null,
    statusText: error.response?.statusText || null,
    data: error.response?.data || null
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
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
  sessionCache.expiresAt = expiration
    ? new Date(expiration).getTime()
    : Date.now() + 110 * 60 * 1000;

  return sessionCache.token;
}

async function skySlopeRequest(method, path, data = null, params = null) {
  const session = await getSkySlopeSession();

  const response = await axios({
    method,
    url: `${SKYSLOPE_BASE_URL}${path}`,
    data,
    params,
    headers: {
      "Content-Type": "application/json",
      "Session": session
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return response.data;
}

async function getSaleForm() {
  return await skySlopeRequest("get", "/api/files/saleForm");
}

async function getChecklistTypesSingleOffice() {
  return await skySlopeRequest("get", "/api/checklistTypes", null, {
    transactionType: "Sale"
  });
}

async function getContacts(query = {}) {
  return await skySlopeRequest("get", "/api/contacts", null, query);
}

async function getSales(params = {}) {
  return await skySlopeRequest("get", "/api/files/sales", null, params);
}

async function getSaleByGuid(saleGuid) {
  return await skySlopeRequest("get", `/api/files/sales/${saleGuid}`);
}

async function downloadFileAsBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data).toString("base64");
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "SkySlope middleware running" });
});

app.get("/auth-test", async (req, res) => {
  try {
    const session = await getSkySlopeSession();
    res.json({
      ok: true,
      message: "SkySlope authentication successful",
      sessionPreview: String(session).slice(0, 8) + "..."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.get("/debug/checklist-types", async (req, res) => {
  try {
    const result = await getChecklistTypesSingleOffice();
    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.get("/debug/contacts", async (req, res) => {
  try {
    const result = await getContacts({
      firstName: req.query.firstName || undefined,
      lastName: req.query.lastName || undefined,
      email: req.query.email || undefined,
      phone: req.query.phone || undefined
    });

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.get("/debug/sales", async (req, res) => {
  try {
    const result = await getSales({
      pageNumber: req.query.pageNumber || 1,
      pageSize: req.query.pageSize || 10,
      email: req.query.email || undefined,
      status: req.query.status || "all",
      createdByGuid: req.query.createdByGuid || undefined,
      agentGuid: req.query.agentGuid || undefined
    });

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.get("/debug/sale/:saleGuid", async (req, res) => {
  try {
    const result = await getSaleByGuid(req.params.saleGuid);
    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post("/api/skyslope-upload", async (req, res) => {
  const debug = [];

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
      company: "",
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

    const attachments = normalizeAttachments(
      req.body.attachments || req.body.attachmentsJson
    );

    debug.push({
      step: "input-normalized",
      clientFullName: buyer.fullName,
      clientEmail: buyer.email,
      clientPhone: buyer.phone,
      agentFullName: agent.fullName,
      agentEmail: agent.email,
      attachmentCount: attachments.length,
      checklistTypeId: DEFAULT_CHECKLIST_TYPE_ID
    });

    return res.status(500).json({
      ok: false,
      error: "Create flow not finalized yet. Next step is to discover OfficeGuid and AgentGuid via /debug/sales and /debug/sale/:saleGuid.",
      buyer,
      agent,
      attachmentCount: attachments.length,
      checklistTypeId: DEFAULT_CHECKLIST_TYPE_ID,
      debug
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
      debug
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

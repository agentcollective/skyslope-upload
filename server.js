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

  DEFAULT_CHECKLIST_LABEL = "Residential - Traditional",
  DEFAULT_PROPERTY_TYPE = "Residential",
  DEFAULT_PROPERTY_SUBTYPE = "Other"
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

async function downloadFileAsBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data).toString("base64");
}

function safeLower(value) {
  return String(value || "").toLowerCase();
}

function getFieldsArray(formResponse) {
  return formResponse?.value?.fields || formResponse?.fields || formResponse?.data?.fields || [];
}

function fieldByName(formResponse, targetName) {
  const fields = getFieldsArray(formResponse);
  return fields.find(f => safeLower(f.fieldName) === safeLower(targetName));
}

function fieldSelections(formResponse, targetName) {
  return fieldByName(formResponse, targetName)?.allowableSelections || [];
}

function findSelectionByLabel(selections, preferredLabels = []) {
  if (!Array.isArray(selections)) return null;

  for (const preferred of preferredLabels) {
    const found = selections.find(item => {
      const label = safeLower(
        item?.sourceName ||
        item?.name ||
        item?.label ||
        item?.text ||
        item?.displayName ||
        item?.value
      );
      return label.includes(safeLower(preferred));
    });
    if (found) return found;
  }

  return selections[0] || null;
}

function extractChecklistId(checklistResponse, preferredLabel) {
  const root =
    checklistResponse?.value ||
    checklistResponse?.data ||
    checklistResponse ||
    {};

  const all =
    root?.checklistTypes ||
    root?.items ||
    root?.value ||
    root?.results ||
    [];

  if (!Array.isArray(all)) {
    return null;
  }

  const preferred = all.find(item => {
    const name = safeLower(
      item?.checklistTypeName ||
      item?.name ||
      item?.label ||
      item?.text ||
      item?.displayName
    );
    return name.includes(safeLower(preferredLabel));
  });

  const chosen = preferred || all[0];

  if (!chosen) return null;

  return {
    checklistTypeId: pickFirst(
      chosen?.checklistTypeId,
      chosen?.id,
      chosen?.value
    ),
    checklistTypeName: pickFirst(
      chosen?.checklistTypeName,
      chosen?.name,
      chosen?.label,
      chosen?.text,
      chosen?.displayName
    ),
    raw: chosen
  };
}

function extractCreateSaleRequirements(saleForm) {
  const officeField = fieldByName(saleForm, "OfficeGuid");
  const agentField = fieldByName(saleForm, "AgentGuid");
  const checklistField = fieldByName(saleForm, "ChecklistTypeId");
  const propertyField = fieldByName(saleForm, "Property");
  const sourceField = fieldByName(saleForm, "SourceId");

  return {
    officeField,
    agentField,
    checklistField,
    sourceField,
    propertyField,
    sourceSelections: sourceField?.allowableSelections || [],
    propertySubFields: propertyField?.subFields || []
  };
}

async function getSaleForm() {
  return await skySlopeRequest("get", "/api/files/saleForm");
}

async function getChecklistTypesSingleOffice() {
  return await skySlopeRequest("get", "/api/checklistTypes", null, {
    transactionType: "Sale"
  });
}

async function getChecklistTypesByOffice(officeGuid) {
  return await skySlopeRequest("get", `/api/offices/${officeGuid}/checklistTypes`, null, {
    transactionType: "Sale"
  });
}

async function getContacts(query = {}) {
  return await skySlopeRequest("get", "/api/contacts", null, query);
}

async function getCurrentFilesSample() {
  return await skySlopeRequest("get", "/api/files", null, {
    type: "summary",
    status: "active"
  });
}

function base64EncodeNumericId(value) {
  return Buffer.from(String(value)).toString("base64");
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
    console.error("SkySlope auth test failed:", error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.get("/debug/sale-form", async (req, res) => {
  try {
    const saleForm = await getSaleForm();
    const requirements = extractCreateSaleRequirements(saleForm);

    res.json({
      ok: true,
      saleForm,
      extracted: requirements
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
    const officeGuid = cleanString(req.query.officeGuid);
    const result = officeGuid
      ? await getChecklistTypesByOffice(officeGuid)
      : await getChecklistTypesSingleOffice();

    res.json({
      ok: true,
      officeGuid: officeGuid || null,
      result,
      extractedPreferred: extractChecklistId(result, DEFAULT_CHECKLIST_LABEL)
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

app.get("/debug/files-sample", async (req, res) => {
  try {
    const result = await getCurrentFilesSample();
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

app.get("/debug/decode-transaction-id", (req, res) => {
  try {
    const encoded = cleanString(req.query.value);
    if (!encoded) {
      return res.status(400).json({
        ok: false,
        error: "Missing query param: value"
      });
    }

    const decoded = Buffer.from(encoded, "base64").toString("utf8");

    res.json({
      ok: true,
      encoded,
      decoded
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
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
      attachmentCount: attachments.length
    });

    const saleForm = await getSaleForm();
    const requirements = extractCreateSaleRequirements(saleForm);

    debug.push({
      step: "sale-form-fetched",
      extracted: requirements
    });

    return res.status(500).json({
      ok: false,
      error: "Create flow not finalized yet. Use the new debug endpoints to discover OfficeGuid, AgentGuid, and ChecklistTypeId first.",
      buyer,
      agent,
      attachmentCount: attachments.length,
      debug
    });
  } catch (error) {
    console.error("SkySlope upload failure:", error.response?.data || error.message);

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

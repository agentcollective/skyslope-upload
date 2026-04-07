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
  DEBUG_SKYSLOPE = "true"
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

function summarizeAxiosError(error) {
  return {
    message: error.message,
    status: error.response?.status || null,
    statusText: error.response?.statusText || null,
    data: error.response?.data || null
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

async function getSaleForm() {
  return await skySlopeRequest("get", "/api/files/saleForm");
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function extractFromCollection(collection, preferredLabels = []) {
  if (!Array.isArray(collection)) return undefined;

  for (const preferredLabel of preferredLabels) {
    const found = collection.find(item => {
      const label = String(
        item?.label ||
        item?.name ||
        item?.text ||
        item?.displayName ||
        ""
      ).toLowerCase();

      return label.includes(preferredLabel.toLowerCase());
    });

    if (found) {
      return pickFirst(
        found.guid,
        found.value,
        found.id,
        found.key,
        found.officeGuid,
        found.agentGuid,
        found.checklistTypeId
      );
    }
  }

  const first = collection[0];
  return pickFirst(
    first?.guid,
    first?.value,
    first?.id,
    first?.key,
    first?.officeGuid,
    first?.agentGuid,
    first?.checklistTypeId
  );
}

function buildSaleCreatePayloadFromForm(saleForm) {
  const root = saleForm?.data || saleForm?.value || saleForm || {};

  const officeGuid = pickFirst(
    root.officeGuid,
    root.office?.guid,
    root.defaultOfficeGuid,
    extractFromCollection(root.offices, ["gilbert"]),
    extractFromCollection(root.officeOptions, ["gilbert"]),
    extractFromCollection(root.availableOffices, ["gilbert"]),
    extractFromCollection(root.officeList, ["gilbert"])
  );

  const agentGuid = pickFirst(
    root.agentGuid,
    root.agent?.guid,
    root.defaultAgentGuid,
    extractFromCollection(root.agents),
    extractFromCollection(root.agentOptions),
    extractFromCollection(root.availableAgents),
    extractFromCollection(root.userOptions)
  );

  const checklistTypeId = pickFirst(
    root.checklistTypeId,
    root.checklistType?.id,
    root.defaultChecklistTypeId,
    extractFromCollection(root.checklistTypes),
    extractFromCollection(root.checklistTypeOptions),
    extractFromCollection(root.availableChecklistTypes)
  );

  const propertyType = pickFirst(
    root.propertyType,
    root.defaultPropertyType,
    "Residential"
  );

  const subType = pickFirst(
    root.subType,
    root.subtype,
    root.defaultSubType,
    root.defaultSubtype,
    "Other"
  );

  const transactionType = pickFirst(
    root.transactionType,
    root.defaultTransactionType,
    "Purchase"
  );

  const stage = pickFirst(
    root.stage,
    root.defaultStage,
    "PreContract"
  );

  const saleType = pickFirst(
    root.saleType,
    root.defaultSaleType,
    "PassThrough"
  );

  return {
    officeGuid,
    agentGuid,
    checklistTypeId,
    propertyType,
    subType,
    transactionType,
    stage,
    saleType
  };
}

async function createSaleFromForm() {
  const saleForm = await getSaleForm();
  const payload = buildSaleCreatePayloadFromForm(saleForm);

  const missing = [];
  if (!payload.officeGuid) missing.push("officeGuid");
  if (!payload.agentGuid) missing.push("agentGuid");
  if (payload.checklistTypeId === undefined || payload.checklistTypeId === null || payload.checklistTypeId === "") {
    missing.push("checklistTypeId");
  }

  if (missing.length) {
    throw new Error(
      `saleForm did not provide required values: ${missing.join(", ")}. Raw form: ${JSON.stringify(saleForm)}`
    );
  }

  const sale = await skySlopeRequest("post", "/api/files/sales", payload);

  const saleGuid = pickFirst(
    sale?.guid,
    sale?.saleGuid,
    sale?.id,
    sale?.data?.guid,
    sale?.data?.saleGuid,
    sale?.value?.guid,
    sale?.value?.saleGuid
  );

  if (!saleGuid) {
    throw new Error(`Could not determine saleGuid from response: ${JSON.stringify(sale)}`);
  }

  return {
    saleGuid,
    saleForm,
    payload,
    sale
  };
}

async function addBuyerToSale(saleGuid, buyer) {
  const payload = {
    firstName: buyer.firstName,
    lastName: buyer.lastName,
    email: buyer.email,
    phoneNumber: buyer.phone
  };

  return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/buyerContact`, payload);
}

async function getAddDocumentsToSaleForm(saleGuid) {
  return await skySlopeRequest("get", `/api/files/sales/${saleGuid}/addDocumentsToSaleForm`);
}

async function uploadDocumentToSale(saleGuid, attachment) {
  await getAddDocumentsToSaleForm(saleGuid);

  const base64Content = await downloadFileAsBase64(attachment.url);

  const payload = {
    fileName: attachment.fileName,
    base64Content
  };

  return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/documents`, payload);
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

app.post("/api/skyslope-upload", async (req, res) => {
  const debug = [];
  let saleGuid = null;

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

    const saleCreate = await createSaleFromForm();
    saleGuid = saleCreate.saleGuid;

    debug.push({
      step: "sale-created",
      saleGuid,
      payloadUsed: saleCreate.payload,
      saleFormSample: DEBUG_SKYSLOPE === "true" ? saleCreate.saleForm : undefined
    });

    let buyerContactResult = null;
    try {
      buyerContactResult = await addBuyerToSale(saleGuid, buyer);
      debug.push({
        step: "buyer-added",
        result: buyerContactResult
      });
    } catch (buyerError) {
      debug.push({
        step: "buyer-add-failed",
        error: summarizeAxiosError(buyerError)
      });
    }

    const uploaded = [];
    for (const attachment of attachments) {
      try {
        const result = await uploadDocumentToSale(saleGuid, attachment);
        uploaded.push({
          fileName: attachment.fileName,
          uploaded: true,
          result
        });
      } catch (uploadError) {
        uploaded.push({
          fileName: attachment.fileName,
          uploaded: false,
          error: summarizeAxiosError(uploadError)
        });
      }
    }

    const uploadedSuccessCount = uploaded.filter(x => x.uploaded).length;
    const uploadedFailCount = uploaded.filter(x => !x.uploaded).length;

    const summaryText =
      `SkySlope upload completed. ` +
      `Client: ${buyer.fullName}. ` +
      `Client email used: ${buyer.email}. ` +
      `Client phone used: ${buyer.phone}. ` +
      `Agent: ${agent.fullName || "Unknown Agent"} <${agent.email || "unknown"}>. ` +
      `Uploaded successfully: ${uploadedSuccessCount}. ` +
      `Upload failures: ${uploadedFailCount}.`;

    return res.json({
      ok: uploadedSuccessCount > 0,
      saleGuid,
      clientFullName: buyer.fullName,
      clientEmail: buyer.email,
      clientPhone: buyer.phone,
      agentFullName: agent.fullName,
      agentEmail: agent.email,
      uploadedCount: uploadedSuccessCount,
      failedUploadCount: uploadedFailCount,
      uploaded,
      summaryText,
      debug
    });
  } catch (error) {
    console.error("SkySlope upload failure:", error.response?.data || error.message);

    return res.status(500).json({
      ok: false,
      saleGuid,
      error: error.message,
      details: error.response?.data || null,
      debug
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
